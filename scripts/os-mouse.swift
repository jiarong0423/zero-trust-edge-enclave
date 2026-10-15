// Moves the real macOS pointer and clicks it, so that a screen recording shows the system's own cursor doing what the demo shows.
// Compiled on demand by demo-choreography.mjs:  swiftc -O scripts/os-mouse.swift -o <tmp>/zte-os-mouse
//
//   zte-os-mouse glide X Y MS   move smoothly from where the pointer is now to (X, Y), taking MS milliseconds
//   zte-os-mouse click          press and release the left button where the pointer is
//   zte-os-mouse where          print the pointer position
//
// X and Y are screen points, origin at the top left of the main display. Posting events needs the Accessibility permission of the app that
// started this program; without it macOS drops the events silently, so after a move the position is read back and a mismatch is an error.
import Cocoa

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(3)
}
func here() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
func post(_ type: CGEventType, _ point: CGPoint, clickState: Int64 = 0) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fail("ERROR could not build a mouse event") }
  if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
  event.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: zte-os-mouse glide X Y MS | click | where") }
switch args[1] {
case "glide":
  guard args.count == 5, let x = Double(args[2]), let y = Double(args[3]), let ms = Double(args[4]) else { fail("usage: zte-os-mouse glide X Y MS") }
  let from = here(), to = CGPoint(x: x, y: y)
  let steps = max(1, Int(ms / 8))
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    post(.mouseMoved, CGPoint(x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased))
    usleep(8000)
  }
  usleep(40000)
  let now = here()
  if hypot(now.x - to.x, now.y - to.y) > 3 { fail("ERROR the pointer did not move to (\(Int(x)), \(Int(y))); it is at (\(Int(now.x)), \(Int(now.y))). Does the app that started this have the Accessibility permission?") }
case "click":
  let p = here()
  post(.leftMouseDown, p, clickState: 1)
  usleep(70000)
  post(.leftMouseUp, p, clickState: 1)
case "where":
  let p = here()
  print("\(Int(p.x)) \(Int(p.y))")
default:
  fail("usage: zte-os-mouse glide X Y MS | click | where")
}
