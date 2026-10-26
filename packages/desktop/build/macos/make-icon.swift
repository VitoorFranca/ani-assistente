// Draws the app icon (1024 px PNG): warm paper, a serif "A" and the accent dot.
//   swift make-icon.swift icon-1024.png
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let inset = size * 0.1
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = NSBezierPath(roundedRect: rect, xRadius: size * 0.18, yRadius: size * 0.18)
NSColor(red: 0.965, green: 0.949, blue: 0.906, alpha: 1).setFill()  // --paper
shape.fill()
NSColor(red: 0.098, green: 0.098, blue: 0.086, alpha: 0.12).setStroke()
shape.lineWidth = size * 0.006
shape.stroke()
let font = NSFont(name: "Iowan Old Style", size: size * 0.56) ?? NSFont.systemFont(ofSize: size * 0.56)
let text = NSAttributedString(string: "A", attributes: [
    .font: font,
    .foregroundColor: NSColor(red: 0.098, green: 0.098, blue: 0.086, alpha: 1),  // --ink
])
let textSize = text.size()
text.draw(at: NSPoint(x: (size - textSize.width) / 2 - size * 0.03, y: (size - textSize.height) / 2 - size * 0.02))
let dot = size * 0.085
NSColor(red: 0.671, green: 0.302, blue: 0.153, alpha: 1).setFill()  // --accent
NSBezierPath(ovalIn: NSRect(x: size * 0.68, y: size * 0.30, width: dot, height: dot)).fill()
image.unlockFocus()
let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
