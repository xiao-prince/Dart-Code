import * as path from "path";
import * as vs from "vscode";
import { Analyzer } from "../shared/analyzer";
import { DartCapabilities } from "../shared/capabilities/dart";
import { DaemonCapabilities, FlutterCapabilities } from "../shared/capabilities/flutter";
import { dartPlatformName, flutterExtensionIdentifier, HAS_LAST_DEBUG_CONFIG, HAS_LAST_TEST_DEBUG_CONFIG, isWin, IS_LSP_CONTEXT, IS_RUNNING_LOCALLY_CONTEXT, platformDisplayName, PUB_OUTDATED_SUPPORTED_CONTEXT } from "../shared/constants";
import { LogCategory } from "../shared/enums";
import { WebClient } from "../shared/fetch";
import { DartWorkspaceContext, FlutterWorkspaceContext, IFlutterDaemon, Logger, Sdks } from "../shared/interfaces";
import { captureLogs, EmittingLogger, logToConsole, RingLog } from "../shared/logging";
import { internalApiSymbol } from "../shared/symbols";
import { uniq } from "../shared/utils";
import { fsPath, isWithinPath } from "../shared/utils/fs";
import { FlutterDeviceManager } from "../shared/vscode/device_manager";
import { extensionVersion, isDevExtension } from "../shared/vscode/extension_utils";
import { InternalExtensionApi } from "../shared/vscode/interfaces";
import { DartUriHandler } from "../shared/vscode/uri_handlers/uri_handler";
import { envUtils, getDartWorkspaceFolders, isRunningLocally, warnIfPathCaseMismatch } from "../shared/vscode/utils";
import { Context } from "../shared/vscode/workspace";
import { WorkspaceContext } from "../shared/workspace";
import { DasAnalyzer } from "./analysis/analyzer_das";
import { AnalyzerStatusReporter } from "./analysis/analyzer_status_reporter";
import { FileChangeHandler } from "./analysis/file_change_handler";
import { FileChangeWarnings } from "./analysis/file_change_warnings";
import { DartExtensionApi } from "./api";
import { AnalyzerCommands } from "./commands/analyzer";
import { DebugCommands, debugSessions } from "./commands/debug";
import { EditCommands } from "./commands/edit";
import { DasEditCommands } from "./commands/edit_das";
import { GoToSuperCommand } from "./commands/go_to_super";
import { LoggingCommands } from "./commands/logging";
import { OpenInOtherEditorCommands } from "./commands/open_in_other_editors";
import { RefactorCommands } from "./commands/refactor";
import { SdkCommands } from "./commands/sdk";
import { cursorIsInTest, DasTestCommands, isInImplementationFileThatCanHaveTest, isInTestFileThatHasImplementation } from "./commands/test";
import { TypeHierarchyCommand } from "./commands/type_hierarchy";
import { config } from "./config";
import { setUpDaemonMessageHandler } from "./flutter/daemon_message_handler";
import { FlutterDaemon } from "./flutter/flutter_daemon";
import { HotReloadOnSaveHandler } from "./flutter/hot_reload_save_handler";
import { DartCompletionItemProvider } from "./providers/dart_completion_item_provider";
import { DartDiagnosticProvider } from "./providers/dart_diagnostic_provider";
import { DartLanguageConfiguration } from "./providers/dart_language_configuration";
import { PubBuildRunnerTaskProvider } from "./pub/build_runner_task_provider";
import { PubGlobal } from "./pub/global";
import { StatusBarVersionTracker } from "./sdk/status_bar_version_tracker";
import { checkForStandardDartSdkUpdates } from "./sdk/update_check";
import { SdkUtils } from "./sdk/utils";
import { showUserPrompts } from "./user_prompts";
import * as util from "./utils";
import { addToLogHeader, clearLogHeader, getExtensionLogPath, getLogHeader } from "./utils/log";
import { safeToolSpawn } from "./utils/processes";

const DART_MODE = { language: "dart", scheme: "file" };
const HTML_MODE = { language: "html", scheme: "file" };

const DART_PROJECT_LOADED = "dart-code:dartProjectLoaded";
// TODO: Define what this means better. Some commands a general Flutter (eg. Hot
// Reload) and some are more specific (eg. Attach).
const FLUTTER_PROJECT_LOADED = "dart-code:anyFlutterProjectLoaded";
const FLUTTER_MOBILE_PROJECT_LOADED = "dart-code:flutterMobileProjectLoaded";
const WEB_PROJECT_LOADED = "dart-code:WebProjectLoaded";
export const FLUTTER_SUPPORTS_ATTACH = "dart-code:flutterSupportsAttach";
const DART_PLATFORM_NAME = "dart-code:dartPlatformName";
export const SERVICE_EXTENSION_CONTEXT_PREFIX = "dart-code:serviceExtension.";
export const SERVICE_CONTEXT_PREFIX = "dart-code:service.";

let analyzer: Analyzer;
let flutterDaemon: IFlutterDaemon;
let deviceManager: FlutterDeviceManager;
const dartCapabilities = DartCapabilities.empty;
const flutterCapabilities = FlutterCapabilities.empty;
let analysisRoots: string[] = [];

let showTodos: boolean | undefined;
let previousSettings: string;
const loggers: Array<{ dispose: () => Promise<void> | void }> = [];

const logger = new EmittingLogger();

// Keep a running in-memory buffer of last 200 log events we can give to the
// user when something crashed even if they don't have disk-logging enabled.
export const ringLog: RingLog = new RingLog(200);

export async function activate(context: vs.ExtensionContext, isRestart: boolean = false) {
	if (!isRestart) {
		if (isDevExtension)
			logToConsole(logger);

		logger.onLog((message) => ringLog.log(message.toLine(500)));
	}

	vs.commands.executeCommand("setContext", IS_RUNNING_LOCALLY_CONTEXT, isRunningLocally);
	buildLogHeaders();
	setupLog(getExtensionLogPath(), LogCategory.General);

	const extContext = Context.for(context);
	const webClient = new WebClient(extensionVersion);

	util.logTime("Code called activate");

	// Wire up a reload command that will re-initialise everything.
	context.subscriptions.push(vs.commands.registerCommand("_dart.reloadExtension", async (_) => {
		logger.info("Performing silent extension reload...");
		await deactivate(true);
		const toDispose = context.subscriptions.slice();
		context.subscriptions.length = 0;
		for (const sub of toDispose) {
			try {
				sub.dispose();
			} catch (e) {
				logger.error(e);
			}
		}
		await activate(context, true);
		logger.info("Done!");
	}));

	showTodos = config.showTodos;
	previousSettings = getSettingsThatRequireRestart();

	const extensionStartTime = new Date();
	util.logTime();
	const sdkUtils = new SdkUtils(logger);
	const isUsingLsp = false;
	const workspaceContextUnverified = await sdkUtils.scanWorkspace(isUsingLsp);
	util.logTime("initWorkspace");

	// Create log headers and set up all other log files.
	buildLogHeaders(logger, workspaceContextUnverified);
	setupLog(config.analyzerLogFile, LogCategory.Analyzer);
	setupLog(config.flutterDaemonLogFile, LogCategory.FlutterDaemon);
	setupLog(config.devToolsLogFile, LogCategory.DevTools);

	if (!workspaceContextUnverified.sdks.dart || (workspaceContextUnverified.hasAnyFlutterProjects && !workspaceContextUnverified.sdks.flutter)) {
		// Don't set anything else up; we can't work like this!
		return sdkUtils.handleMissingSdks(context, workspaceContextUnverified);
	}

	const workspaceContext = workspaceContextUnverified as DartWorkspaceContext;
	const sdks = workspaceContext.sdks;

	if (sdks.flutterVersion) {
		flutterCapabilities.version = sdks.flutterVersion;
	}

	vs.commands.executeCommand("setContext", IS_LSP_CONTEXT, workspaceContext.config.useLsp);

	// Show the SDK version in the status bar.
	if (sdks.dartVersion) {
		dartCapabilities.version = sdks.dartVersion;
		// tslint:disable-next-line: no-floating-promises
		checkForStandardDartSdkUpdates(logger, workspaceContext);
		context.subscriptions.push(new StatusBarVersionTracker(workspaceContext, isUsingLsp));
	}
	vs.commands.executeCommand("setContext", PUB_OUTDATED_SUPPORTED_CONTEXT, dartCapabilities.supportsPubOutdated);

	// Fire up the analyzer process.
	const analyzerStartTime = new Date();

	analyzer = new DasAnalyzer(logger, sdks, dartCapabilities, workspaceContext);
	const dasAnalyzer = analyzer as DasAnalyzer;
	const dasClient = dasAnalyzer ? dasAnalyzer.client : undefined;
	context.subscriptions.push(analyzer);

	// tslint:disable-next-line: no-floating-promises
	analyzer.onReady.then(() => {
		const analyzerEndTime = new Date();
	});

	// Log analysis server first analysis completion time when it completes.
	let analysisStartTime: Date;
	const analysisCompleteEvents = analyzer.onAnalysisStatusChange.listen((status) => {
		// Analysis started for the first time.
		if (status.isAnalyzing && !analysisStartTime)
			analysisStartTime = new Date();

		// Analysis ends for the first time.
		if (!status.isAnalyzing && analysisStartTime) {
			const analysisEndTime = new Date();
			analysisCompleteEvents.dispose();
		}
	});

	// Set up providers.
	// TODO: Do we need to push all these to subscriptions?!


	const completionItemProvider = isUsingLsp || !dasClient ? undefined : new DartCompletionItemProvider(logger, dasClient);

	const activeFileFilters: vs.DocumentFilter[] = [DART_MODE];

	// Analyze Angular2 templates, requires the angular_analyzer_plugin.
	if (config.analyzeAngularTemplates) {
		activeFileFilters.push(HTML_MODE);
	}
	// Analyze files supported by plugins.
	for (const ext of uniq(config.additionalAnalyzerFileExtensions)) {
		// We can't check that these don't overlap with the existing language filters
		// because vs.languages.match() won't take an extension, only a TextDocument.
		// So we'll just manually exclude file names we know for sure overlap with them.
		if (ext === "dart" || (config.analyzeAngularTemplates && (ext === "htm" || ext === "html")))
			continue;

		activeFileFilters.push({ scheme: "file", pattern: `**/*.${ext}` });
	}

	const triggerCharacters = ".(${'\"/\\".split("");
	if (completionItemProvider)
		context.subscriptions.push(vs.languages.registerCompletionItemProvider(activeFileFilters, completionItemProvider, ...triggerCharacters));

	// Task handlers.
	if (config.previewBuildRunnerTasks) {
		const provider = new PubBuildRunnerTaskProvider(sdks);
		context.subscriptions.push(vs.tasks.registerTaskProvider(provider.type, provider));
	}

	context.subscriptions.push(vs.languages.setLanguageConfiguration(DART_MODE.language, new DartLanguageConfiguration()));

	if (dasClient)
		// tslint:disable-next-line: no-unused-expression
		new AnalyzerStatusReporter(logger, dasClient, workspaceContext);

	context.subscriptions.push(new FileChangeWarnings());

	// Set up diagnostics.
	if (!isUsingLsp && dasClient) {
		const diagnostics = vs.languages.createDiagnosticCollection("dart");
		context.subscriptions.push(diagnostics);
		const diagnosticsProvider = new DartDiagnosticProvider(dasClient, diagnostics);

		// TODO: Currently calculating analysis roots requires the version to check if
		// we need the package workaround. In future if we stop supporting server < 1.20.1 we
		// can unwrap this call so that it'll start sooner.
		const serverConnected = dasClient.registerForServerConnected((sc) => {
			serverConnected.dispose();
			if (vs.workspace.workspaceFolders)
				recalculateAnalysisRoots();

			// Set up a handler to warn the user if they open a Dart file and we
			// never set up the analyzer
			let hasWarnedAboutLooseDartFiles = false;
			const handleOpenFile = (d: vs.TextDocument) => {
				if (!hasWarnedAboutLooseDartFiles && d.languageId === "dart" && d.uri.scheme === "file" && analysisRoots.length === 0) {
					hasWarnedAboutLooseDartFiles = true;
					vs.window.showWarningMessage("For full Dart language support, please open a folder containing your Dart files instead of individual loose files");
				}
			};
			context.subscriptions.push(vs.workspace.onDidOpenTextDocument((d) => handleOpenFile(d)));
			// Fire for editors already visible at the time this code runs.
			vs.window.visibleTextEditors.forEach((e) => handleOpenFile(e.document));
		});

		// Hook editor changes to send updated contents to analyzer.
		context.subscriptions.push(new FileChangeHandler(dasClient));
	}

	// Fire up Flutter daemon if required.
	if (workspaceContext.hasAnyFlutterMobileProjects && sdks.flutter) {
		flutterDaemon = new FlutterDaemon(logger, workspaceContext as FlutterWorkspaceContext);
		deviceManager = new FlutterDeviceManager(logger, flutterDaemon, config);

		context.subscriptions.push(deviceManager);
		context.subscriptions.push(flutterDaemon);

		setUpDaemonMessageHandler(logger, context, flutterDaemon);

		context.subscriptions.push(vs.commands.registerCommand("flutter.selectDevice", deviceManager.showDevicePicker, deviceManager));
		context.subscriptions.push(vs.commands.registerCommand("flutter.launchEmulator", deviceManager.promptForAndLaunchEmulator, deviceManager));
	}

	util.logTime("All other stuff before debugger..");

	const pubGlobal = new PubGlobal(logger, extContext, sdks);



	if (!isUsingLsp && dasClient && dasAnalyzer) {
		// Setup that requires server version/capabilities.
		const connectedSetup = dasClient.registerForServerConnected(async (sc) => {
			connectedSetup.dispose();

			context.subscriptions.push(new RefactorCommands(logger, context, dasClient));

			// Set up completions for unimported items.
			if (dasClient.capabilities.supportsAvailableSuggestions && config.autoImportCompletions) {
				await dasClient.completionSetSubscriptions({
					subscriptions: ["AVAILABLE_SUGGESTION_SETS"],
				});
			}
		});
	}

	// Handle config changes so we can reanalyze if necessary.
	context.subscriptions.push(vs.workspace.onDidChangeConfiguration(() => handleConfigurationChange(sdks)));

	// Register additional commands.
	const analyzerCommands = new AnalyzerCommands(context, logger, analyzer);
	const sdkCommands = new SdkCommands(logger, context, workspaceContext, sdkUtils, pubGlobal, flutterCapabilities, deviceManager);
	const debugCommands = new DebugCommands(logger, extContext, workspaceContext, pubGlobal);

	// Wire up handling of Hot Reload on Save.
	context.subscriptions.push(new HotReloadOnSaveHandler(debugCommands, flutterCapabilities));

	// Register URI handler.
	context.subscriptions.push(vs.window.registerUriHandler(new DartUriHandler(flutterCapabilities)));

	context.subscriptions.push(new LoggingCommands(logger, context.logPath));
	context.subscriptions.push(new OpenInOtherEditorCommands(logger, sdks));
	if (dasAnalyzer)
		context.subscriptions.push(new DasTestCommands(logger, workspaceContext, dasAnalyzer.fileTracker));


	// Set up commands for Dart editors.
	context.subscriptions.push(new EditCommands());
	if (dasClient && dasAnalyzer) {
		context.subscriptions.push(new DasEditCommands(logger, context, dasClient));
		context.subscriptions.push(new TypeHierarchyCommand(logger, dasClient));
		context.subscriptions.push(new GoToSuperCommand(dasAnalyzer));
	}


	context.subscriptions.push(vs.commands.registerCommand("dart.package.openFile", (filePath) => {
		if (!filePath) return;

		vs.workspace.openTextDocument(filePath).then((document) => {
			vs.window.showTextDocument(document, { preview: true });
		}, (error) => logger.error(error));
	}));

	// Warn the user if they've opened a folder with mismatched casing.
	if (vs.workspace.workspaceFolders && vs.workspace.workspaceFolders.length) {
		for (const wf of vs.workspace.workspaceFolders) {
			if (warnIfPathCaseMismatch(logger, fsPath(wf.uri), "the open workspace folder", "re-open the folder using the File Open dialog"))
				break;
		}
	}

	// Prompt user for any special config we might want to set.
	if (!isRestart)
		// tslint:disable-next-line: no-floating-promises
		showUserPrompts(logger, extContext, webClient, workspaceContext);

	// Turn on all the commands.
	setCommandVisiblity(true, workspaceContext);
	vs.commands.executeCommand("setContext", DART_PLATFORM_NAME, dartPlatformName);

	// Prompt for pub get if required
	function checkForPackages() {
		// Don't prompt for package updates in the Fuchsia tree/Dart SDK repo.
		if (workspaceContext.config.disableAutomaticPackageGet)
			return;
		// tslint:disable-next-line: no-floating-promises
		sdkCommands.fetchPackagesOrPrompt(undefined, { alwaysPrompt: true });
	}
	if (!isRestart)
		checkForPackages();

	// Begin activating dependant packages.
	if (workspaceContext.shouldLoadFlutterExtension) {
		const flutterExtension = vs.extensions.getExtension(flutterExtensionIdentifier);
		if (flutterExtension) {
			logger.info(`Activating Flutter extension for ${workspaceContext.workspaceTypeDescription} project...`);
			// Do NOT await this.. the Flutter extension needs to wait for the Dart extension to finish activating
			// so that it can call its exported API, therefore we'll deadlock if we wait for the Flutter extension
			// to finish activating.
			flutterExtension.activate()
				// Then rebuild log because it includes whether we activated Flutter.
				.then(() => buildLogHeaders(logger, workspaceContextUnverified));
		}
	}

	// Log how long all this startup took.
	const extensionEndTime = new Date();

	// Handle changes to the workspace.
	// Set the roots, handling project changes that might affect SDKs.
	context.subscriptions.push(vs.workspace.onDidChangeWorkspaceFolders(async (f) => {
		// First check if something changed that will affect our SDK, in which case
		// we'll perform a silent restart so that we do new SDK searches.
		const newWorkspaceContext = await sdkUtils.scanWorkspace(isUsingLsp);
		if (
			newWorkspaceContext.hasAnyFlutterProjects !== workspaceContext.hasAnyFlutterProjects
			|| newWorkspaceContext.hasProjectsInFuchsiaTree !== workspaceContext.hasProjectsInFuchsiaTree
		) {
			// tslint:disable-next-line: no-floating-promises
			util.promptToReloadExtension();
			return;
		}

		recalculateAnalysisRoots();
		checkForPackages();
	}));

	return {
		...new DartExtensionApi(),
		[internalApiSymbol]: {
			analyzer,
			analyzerCapabilities: dasClient && dasClient.capabilities,
			cancelAllAnalysisRequests: () => dasClient && dasClient.cancelAllRequests(),
			completionItemProvider,
			context: extContext,
			currentAnalysis: () => analyzer.onCurrentAnalysisComplete,
			daemonCapabilities: flutterDaemon ? flutterDaemon.capabilities : DaemonCapabilities.empty,
			dartCapabilities,
			debugCommands,
			debugSessions,
			envUtils,
			fileTracker: dasAnalyzer.fileTracker,
			flutterCapabilities,
			get cursorIsInTest() { return cursorIsInTest; },
			get isInImplementationFileThatCanHaveTest() { return isInImplementationFileThatCanHaveTest; },
			get isInTestFileThatHasImplementation() { return isInTestFileThatHasImplementation; },
			getLogHeader,
			initialAnalysis: analyzer.onInitialAnalysis,
			isLsp: isUsingLsp,
			logger,
			nextAnalysis: () => analyzer.onNextAnalysisComplete,
			pubGlobal,
			safeToolSpawn,
			webClient,
			workspaceContext,
		} as InternalExtensionApi,
	};
}

function setupLog(logFile: string | undefined, category: LogCategory) {
	if (logFile)
		loggers.push(captureLogs(logger, logFile, getLogHeader(), config.maxLogLineLength, [category]));
}

function buildLogHeaders(logger?: Logger, workspaceContext?: WorkspaceContext) {
	clearLogHeader();
	addToLogHeader(() => `!! PLEASE REVIEW THIS LOG FOR SENSITIVE INFORMATION BEFORE SHARING !!`);
	addToLogHeader(() => ``);
	addToLogHeader(() => `Dart Code extension: ${extensionVersion}`);
	addToLogHeader(() => {
		const ext = vs.extensions.getExtension(flutterExtensionIdentifier)!;
		return `Flutter extension: ${ext.packageJSON.version} (${ext.isActive ? "" : "not "}activated)`;
	});
	addToLogHeader(() => ``);
	addToLogHeader(() => `App: ${vs.env.appName}`);
	if (vs.env.remoteName)
		addToLogHeader(() => `Remote: ${vs.env.remoteName}`);
	addToLogHeader(() => `Version: ${vs.version}`);
	addToLogHeader(() => `Platform: ${platformDisplayName}`);
	if (workspaceContext) {
		addToLogHeader(() => ``);
		addToLogHeader(() => `Workspace type: ${workspaceContext.workspaceTypeDescription}`);
		addToLogHeader(() => `Analyzer type: ${workspaceContext.config.useLsp ? "LSP" : "DAS"}`);
		addToLogHeader(() => `Multi-root?: ${vs.workspace.workspaceFolders && vs.workspace.workspaceFolders.length > 1}`);
		const sdks = workspaceContext.sdks;
		addToLogHeader(() => ``);
		addToLogHeader(() => `Dart SDK:\n    Loc: ${sdks.dart}\n    Ver: ${sdks.dartVersion}`);
		addToLogHeader(() => `Flutter SDK:\n    Loc: ${sdks.flutter}\n    Ver: ${sdks.flutterVersion}`);
	}
	addToLogHeader(() => ``);
	addToLogHeader(() => `HTTP_PROXY: ${process.env.HTTP_PROXY}`);
	addToLogHeader(() => `NO_PROXY: ${process.env.NO_PROXY}`);

	// Any time the log headers are rebuilt, we should re-log them.
	logger?.info(getLogHeader());
}

function recalculateAnalysisRoots() {
	analysisRoots = getDartWorkspaceFolders().map((w) => fsPath(w.uri));

	// Sometimes people open their home directories as the workspace root and
	// have all sorts of performance issues because of PubCache and AppData folders
	// so we will exclude them if the user has opened a parent folder (opening a
	// child of these directly will still work).
	const excludeFolders: string[] = [];
	if (isWin) {
		const addExcludeIfRequired = (folder: string | undefined) => {
			if (!folder || !path.isAbsolute(folder))
				return;
			const containingRoot = analysisRoots.find((root: string) => isWithinPath(folder, root));
			if (containingRoot) {
				logger.info(`Excluding folder ${folder} from analysis roots as it is a child of analysis root ${containingRoot} and may cause performance issues.`);
				excludeFolders.push(folder);
			}
		};

		addExcludeIfRequired(process.env.PUB_CACHE);
		addExcludeIfRequired(process.env.APPDATA);
		addExcludeIfRequired(process.env.LOCALAPPDATA);
	}

	// For each workspace, handle excluded folders.
	getDartWorkspaceFolders().forEach((f) => {
		const excludedForWorkspace = config.for(f.uri).analysisExcludedFolders;
		const workspacePath = fsPath(f.uri);
		if (excludedForWorkspace && Array.isArray(excludedForWorkspace)) {
			excludedForWorkspace.forEach((folder) => {
				// Handle both relative and absolute paths.
				if (!path.isAbsolute(folder))
					folder = path.join(workspacePath, folder);
				excludeFolders.push(folder);
			});
		}
	});

	// tslint:disable-next-line: no-floating-promises
	(analyzer as DasAnalyzer).client.analysisSetAnalysisRoots({
		excluded: excludeFolders,
		included: analysisRoots,
	});
}

function handleConfigurationChange(sdks: Sdks) {
	// TODOs
	const newShowTodoSetting = config.showTodos;
	const todoSettingChanged = showTodos !== newShowTodoSetting;
	showTodos = newShowTodoSetting;

	// SDK
	const newSettings = getSettingsThatRequireRestart();
	const settingsChanged = previousSettings !== newSettings;
	previousSettings = newSettings;

	if (todoSettingChanged && analyzer instanceof DasAnalyzer) {
		// tslint:disable-next-line: no-floating-promises
		analyzer.client.analysisReanalyze();
	}

	if (settingsChanged) {
		// tslint:disable-next-line: no-floating-promises
		util.promptToReloadExtension();
	}
}

function getSettingsThatRequireRestart() {
	// The return value here is used to detect when any config option changes that requires a project reload.
	// It doesn't matter how these are combined; it just gets called on every config change and compared.
	// Usually these are options that affect the analyzer and need a reload, but config options used at
	// activation time will also need to be included.
	return "CONF-"
		+ config.sdkPath
		+ config.sdkPaths?.length
		+ config.analyzerPath
		+ config.analyzerDiagnosticsPort
		+ config.analyzerVmServicePort
		+ config.analyzerInstrumentationLogFile
		+ config.extensionLogFile
		+ config.analyzerAdditionalArgs
		+ config.flutterSdkPath
		+ config.flutterSdkPaths?.length
		+ config.flutterSelectDeviceWhenConnected
		+ config.closingLabels
		+ config.analyzeAngularTemplates
		+ config.analysisServerFolding
		+ config.showMainCodeLens
		+ config.showTestCodeLens
		+ config.previewBuildRunnerTasks
		+ config.updateImportsOnRename
		+ config.previewBazelWorkspaceCustomScripts
		+ config.flutterOutline
		+ config.triggerSignatureHelpAutomatically
		+ config.flutterAdbConnectOnChromeOs;
}

export async function deactivate(isRestart: boolean = false): Promise<void> {
	setCommandVisiblity(false);
	await analyzer.dispose();
	vs.commands.executeCommand("setContext", FLUTTER_SUPPORTS_ATTACH, false);
	if (!isRestart) {
		vs.commands.executeCommand("setContext", HAS_LAST_DEBUG_CONFIG, false);
		vs.commands.executeCommand("setContext", HAS_LAST_TEST_DEBUG_CONFIG, false);
		if (loggers) {
			await Promise.all(loggers.map((logger) => logger.dispose()));
			loggers.length = 0;
		}
	}
}

function setCommandVisiblity(enable: boolean, workspaceContext?: WorkspaceContext) {
	vs.commands.executeCommand("setContext", DART_PROJECT_LOADED, enable);
	// TODO: Make this more specific. Maybe the one above?
	vs.commands.executeCommand("setContext", FLUTTER_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyFlutterProjects);
	vs.commands.executeCommand("setContext", FLUTTER_MOBILE_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyFlutterMobileProjects);
	vs.commands.executeCommand("setContext", WEB_PROJECT_LOADED, enable && workspaceContext && workspaceContext.hasAnyWebProjects);
}
