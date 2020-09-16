import { Diagnostic, DiagnosticCollection, DiagnosticSeverity, Uri } from "vscode";
import * as as from "../../shared/analysis_server_types";
import { toRangeOnLine } from "../../shared/vscode/utils";
import { DasAnalyzerClient } from "../analysis/analyzer_das";

// TODO: This is not a provider?
export class DartDiagnosticProvider {
	constructor(private readonly analyzer: DasAnalyzerClient, private readonly diagnostics: DiagnosticCollection) {
		this.analyzer.registerForAnalysisErrors((es) => this.handleErrors(es));
	}

	private handleErrors(notification: as.AnalysisErrorsNotification) {
		const errors = notification.errors;
		this.diagnostics.set(
			Uri.file(notification.file),
			errors.map((e) => DartDiagnosticProvider.createDiagnostic(e)),
		);
	}

	public static createDiagnostic(error: as.AnalysisError): Diagnostic {
		const diag = new Diagnostic(
			toRangeOnLine(error.location),
			error.message,
			DiagnosticSeverity.Error
		);
		diag.code = error.url ? { value: error.code, target: Uri.parse(error.url) } : error.code;
		diag.source = "dart";
		if (error.correction)
			diag.message += `\n${error.correction}`;
		return diag;
	}

}

