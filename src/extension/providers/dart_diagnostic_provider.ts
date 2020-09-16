import { Diagnostic, DiagnosticCollection, DiagnosticRelatedInformation, DiagnosticSeverity, Location, Range, Uri } from "vscode";
import * as as from "../../shared/analysis_server_types";
import { toRangeOnLine } from "../../shared/vscode/utils";
import { DasAnalyzerClient } from "../analysis/analyzer_das";
import { config } from "../config";

// TODO: This is not a provider?
export class DartDiagnosticProvider {
	private lastErrorJson: string | undefined;
	constructor(private readonly analyzer: DasAnalyzerClient, private readonly diagnostics: DiagnosticCollection) {
		this.analyzer.registerForAnalysisErrors((es) => this.handleErrors(es));
	}

	private handleErrors(notification: as.AnalysisErrorsNotification) {
		const notificationJson = JSON.stringify(notification);

		// As a workaround for https://github.com/Dart-Code/Dart-Code/issues/1678, if
		// the errors we got are exactly the same as the previous set, do not give
		// them to VS Code. This avoids a potential loop of refreshing the error view
		// which triggers a request for Code Actions, which could result in analysis
		// of the file (which triggers errors to be sent, which triggers a refresh
		// of the error view... etc.!).
		if (this.lastErrorJson === notificationJson) {
			// TODO: Come up with a better fix than this!
			// log("Skipping error notification as it was the same as the previous one");
			return;
		}

		let errors = notification.errors;
		if (!config.showTodos)
			errors = errors.filter((error) => error.type !== "TODO");
		this.diagnostics.set(
			Uri.file(notification.file),
			errors.map((e) => DartDiagnosticProvider.createDiagnostic(e)),
		);
		this.lastErrorJson = notificationJson;
	}

	public static createDiagnostic(error: as.AnalysisError): Diagnostic {
		const diag = new DartDiagnostic(
			toRangeOnLine(error.location),
			error.message,
			DiagnosticSeverity.Error,
			error.type,
		);
		diag.code = error.url ? { value: error.code, target: Uri.parse(error.url) } : error.code;
		diag.source = "dart";
		if (error.correction)
			diag.message += `\n${error.correction}`;
		if (error.contextMessages && error.contextMessages.length)
			diag.relatedInformation = error.contextMessages.map(DartDiagnosticProvider.createRelatedInformation);
		return diag;
	}

	public static createRelatedInformation(related: as.DiagnosticMessage) {
		return new DiagnosticRelatedInformation(
			new Location(
				Uri.file(related.location.file),
				toRangeOnLine(related.location),
			),
			related.message,
		);
	}
}

export class DartDiagnostic extends Diagnostic {
	constructor(
		range: Range,
		message: string,
		severity: DiagnosticSeverity,
		public readonly type: string,
	) {
		super(range, message, severity);
	}
}
