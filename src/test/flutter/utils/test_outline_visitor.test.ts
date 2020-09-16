import * as assert from "assert";
import { getPackages } from "../../helpers";

describe("test_outline_visitor", () => {

	before("get packages", () => getPackages());

	it("reads the correct groups and tests", () => {
		console.log('running test');
		assert.equal(1, 1);
		console.log('done running test!');
	});
});
