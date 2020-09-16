import * as fs from "fs";
import * as path from "path";
import * as vstest from "vscode-test";

let exitCode = 0;
const cwd = process.cwd();
const testEnv = Object.create(process.env);

async function runTests(testFolder: string, workspaceFolder: string, logSuffix?: string, env?: {}): Promise<void> {
	console.log(
		`Running ${testFolder} tests folder in workspace ${workspaceFolder}`);

	const logsName = process.env.LOGS_NAME;
	const testRunName = `${testFolder.replace("/", "_")}${logSuffix ? `_${logSuffix}` : ""}_${logsName}`;

	testEnv.TEST_RUN_NAME = testRunName;
	testEnv.DC_TEST_LOGS = path.join(cwd, ".dart_code_test_logs", `${testRunName}`);
	testEnv.COVERAGE_OUTPUT = path.join(cwd, ".nyc_output", `${testRunName}.json`);
	testEnv.TEST_XML_OUTPUT = path.join(path.join(cwd, ".test_results"), `${testRunName}.xml`);
	testEnv.TEST_CSV_SUMMARY = path.join(path.join(cwd, ".test_results"), `${testRunName}_summary.csv`);

	if (!fs.existsSync(testEnv.DC_TEST_LOGS))
		fs.mkdirSync(testEnv.DC_TEST_LOGS);

	// The VS Code download is often flaky on GH Actions, so we want to retry
	// if required - however we don't want to re-run tests if they fail, so do
	// the download step separately.
	let currentAttempt = 1;
	const maxAttempts = 5;
	while (currentAttempt <= maxAttempts) {
		try {
			console.log(`Attempting to download VS Code attempt #${currentAttempt}`);
			await vstest.downloadAndUnzipVSCode(process.env.CODE_VERSION);
			break;
		} catch (e) {
			if (currentAttempt >= maxAttempts)
				throw e;

			console.warn(`Failed to download VS Code, will retry: ${e}`);
			currentAttempt++;
		}
	}

	console.log("Running tests with pre-downloaded VS Code");
	try {
		const res = await vstest.runTests({
			extensionDevelopmentPath: cwd,
			extensionTestsEnv: { ...testEnv, ...env },
			extensionTestsPath: path.join(cwd, "out", "src", "test", testFolder),
			launchArgs: [
				path.isAbsolute(workspaceFolder)
					? workspaceFolder
					: path.join(cwd, "src", "test", "test_projects", workspaceFolder),
				"--user-data-dir",
				path.join(cwd, ".dart_code_test_data_dir", testFolder),
			],
			version: process.env.CODE_VERSION,
		});
		exitCode = exitCode || res;
	} catch (e) {
		console.error(e);
		exitCode = exitCode || 999;
	}

	console.log("############################################################");
	console.log("\n\n");
}

async function runAllTests(): Promise<void> {
	if (process.env.CI) {
		console.log("\n\n");
		console.log("A combined test summary will be available at:");
		console.log(`  https://dartcode.org/test-results/?${process.env.GITHUB_REF}/${process.env.GITHUB_SHA}`);
		console.log("\n\n");
	}

	testEnv.DART_CODE_IS_TEST_RUN = true;
	testEnv.MOCHA_FORBID_ONLY = true;

	// Ensure any necessary folders exist.
	if (!fs.existsSync(".nyc_output"))
		fs.mkdirSync(".nyc_output");
	if (!fs.existsSync(".dart_code_test_logs"))
		fs.mkdirSync(".dart_code_test_logs");

	try {
		await runTests("flutter", "flutter_hello_world");
	} catch (e) {
		exitCode = 1;
		console.error(e);
	}
}

// tslint:disable-next-line: no-floating-promises
runAllTests().then(() => process.exit(exitCode));
