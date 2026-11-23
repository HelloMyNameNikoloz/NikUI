import Foundation

public enum ControllerArguments {
    public static func valid(_ arguments: [String]) -> Bool {
        guard let command = arguments.first else { return false }
        if arguments.count == 1 { return true }
        return command == "quit-app" && arguments.dropFirst().allSatisfy {
            guard let pid = Int32($0) else { return false }
            return pid > 0 && String(pid) == $0
        }
    }
}
