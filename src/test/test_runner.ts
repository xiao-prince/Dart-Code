console.log("Starting test runner...");

import * as glob from "glob";
import * as Mocha from "mocha";
import * as path from "path";

module.exports = {
	run(testsRoot: string, cb: (error: any, failures?: number) => void): void {
		// Create the mocha test
		const mocha = new Mocha({
			color: true,
			reporter: Mocha.reporters.Spec,
			slow: 1000,       // increased threshold before marking a test as slow
			timeout: 10000,   // increased timeout because starting up Code, Analyzer, Pub, etc. is slooow
			ui: "bdd",         // the TDD UI is being used in extension.test.ts (suite, test, etc.)
		});

		const callCallback = (error: any, failures?: number) => {
			console.log(`Test run is complete! Calling VS Code callback with (${error}, ${failures})`);
			cb(error, failures);

			// This doesn't work either...
			// process.stdin.end();
		};

		glob("**/**.test.js", { cwd: testsRoot }, (err, files) => {
			if (err) {
				return callCallback(err);
			}

			// Add files to the test suite
			files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

			try {
				// Run the mocha test
				mocha.run((failures) => callCallback(null, failures));
			} catch (err) {
				callCallback(err);
			}
		});
	},
};
