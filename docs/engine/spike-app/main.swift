import Foundation
import ServiceManagement
import Security

let label = "com.nikui.spike.engine.plist"
func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
let svc = SMAppService.agent(plistName: label)
func statusName(_ s: SMAppService.Status) -> String {
  switch s { case .notRegistered: return "notRegistered"; case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"; case .notFound: return "notFound"; @unknown default: return "unknown" } }
let args = CommandLine.arguments.dropFirst()
let cmd = args.first ?? "status"
let service = "com.nikui.spike"
switch cmd {
case "register": do { try svc.register(); out("registered: \(statusName(svc.status))") } catch { out("register failed: \(error)") }
case "unregister": do { try svc.unregister(); out("unregistered: \(statusName(svc.status))") } catch { out("unregister failed: \(error)") }
case "status": out(statusName(svc.status))
case "kc-set": // secret read from stdin, never argv
  let secret = FileHandle.standardInput.readDataToEndOfFile()
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: args.dropFirst().first ?? "probe"]
  SecItemDelete(q as CFDictionary)
  var add = q; add[kSecValueData as String] = secret; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  out("add: \(SecItemAdd(add as CFDictionary, nil))")
case "kc-get":
  var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: args.dropFirst().first ?? "probe", kSecReturnData as String: true]
  var r: CFTypeRef?; let st = SecItemCopyMatching(q as CFDictionary, &r)
  if st == errSecSuccess, let d = r as? Data { FileHandle.standardOutput.write(d) } else { out("get: \(st)") }
  q.removeValue(forKey: kSecReturnData as String)
case "kc-del":
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: args.dropFirst().first ?? "probe"]
  out("del: \(SecItemDelete(q as CFDictionary))")
default: out("usage: register|unregister|status|kc-set|kc-get|kc-del")
}
