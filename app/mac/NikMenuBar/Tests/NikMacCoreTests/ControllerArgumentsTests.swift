import Testing
@testable import NikMacCore

@Suite("Exact app controller arguments") struct ControllerArgumentsTests {
    @Test func acceptsOnlyPositiveExactPIDsForQuit() {
        #expect(ControllerArguments.valid(["quit-app", "42", "56"]))
        #expect(ControllerArguments.valid(["app-status"]))
        for arguments in [["start", "42"], ["quit-app", "-1"], ["quit-app", "0"],
                          ["quit-app", "not-a-pid"], ["quit-app", "042"], []] {
            #expect(!ControllerArguments.valid(arguments))
        }
    }
}
