import { execFileSync } from 'node:child_process';

import { normalizeArticleUrl } from './utils.js';

const OPEN_KNOWLEDGE_APPLESCRIPT = [
    'tell application "System Events" to tell process "ima.copilot"',
    'set frontmost to true',
    'if exists front window then',
    'repeat with itemRef in (entire contents of front window)',
    'try',
    'if description of itemRef is "知识库" then click itemRef',
    'end try',
    'end repeat',
    'end if',
    'end tell',
    'delay 1',
];

const AX_KNOWLEDGE_SCRIPT = String.raw`
import Cocoa
import ApplicationServices

struct DriverError: Error {
    let code: String
    let message: String
}

struct Candidate {
    let name: String
    let id: String
    let element: AXUIElement
}

let query = CommandLine.arguments.dropFirst().first ?? ""
let bundleID = "com.tencent.imamac"

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    if let value = attribute(element, name) as? String { return value }
    if let value = attribute(element, name) as? URL { return value.absoluteString }
    return nil
}

func elementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
    guard let value = attribute(element, name) else { return nil }
    return (value as! AXUIElement)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func role(_ element: AXUIElement) -> String {
    return stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
}

func label(_ element: AXUIElement) -> String? {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
        if let value = stringAttribute(element, key as CFString), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
    return nil
}

func descendants(_ root: AXUIElement, limit: Int = 12000) -> [AXUIElement] {
    var result: [AXUIElement] = []
    var queue = children(root)
    var seen = Set<CFHashCode>()
    while !queue.isEmpty && result.count < limit {
        let item = queue.removeFirst()
        let hash = CFHash(item)
        if seen.contains(hash) { continue }
        seen.insert(hash)
        result.append(item)
        queue.append(contentsOf: children(item))
    }
    return result
}

func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

func pause(_ seconds: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

func clickCenter(_ element: AXUIElement) -> Bool {
    guard let positionValue = attribute(element, kAXPositionAttribute as CFString),
          let sizeValue = attribute(element, kAXSizeAttribute as CFString) else { return false }
    let rawPosition = positionValue as! AXValue
    let rawSize = sizeValue as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(rawPosition, .cgPoint, &position),
          AXValueGetValue(rawSize, .cgSize, &size), size.width > 1, size.height > 1 else { return false }
    let point = CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { return false }
    down.post(tap: CGEventTapLocation.cghidEventTap)
    up.post(tap: CGEventTapLocation.cghidEventTap)
    return true
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = attribute(element, kAXPositionAttribute as CFString),
          let sizeValue = attribute(element, kAXSizeAttribute as CFString) else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
}

func actionable(_ element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<7 {
        guard let item = current else { return nil }
        if actions(item).contains(kAXPressAction as String) { return item }
        current = elementAttribute(item, kAXParentAttribute as CFString)
    }
    return nil
}

@discardableResult
func press(_ element: AXUIElement) -> Bool {
    if let target = actionable(element), AXUIElementPerformAction(target, kAXPressAction as CFString) == .success {
        return true
    }
    var current: AXUIElement? = element
    for _ in 0..<5 {
        guard let item = current else { return false }
        if role(item) == (kAXGroupRole as String), clickCenter(item) { return true }
        current = elementAttribute(item, kAXParentAttribute as CFString)
    }
    return clickCenter(element)
}

func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if condition() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    } while Date() < deadline
    return false
}

func windows(_ app: AXUIElement) -> [AXUIElement] {
    let all = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    return all.filter { !children($0).isEmpty }
        .sorted { descendants($0, limit: 300).count > descendants($1, limit: 300).count }
}

func knowledgeWindow(_ app: AXUIElement) -> AXUIElement? {
    return windows(app).first(where: { !pageKnowledgeID($0).isEmpty })
}

func publicURL(in root: AXUIElement) -> String? {
    func acceptable(_ value: String?) -> String? {
        guard let value, value.hasPrefix("http://") || value.hasPrefix("https://") else { return nil }
        return value.contains("ima.qq.com") || value.contains("ima.copilot") ? nil : value
    }
    if let value = acceptable(stringAttribute(root, kAXURLAttribute as CFString)) { return value }
    for element in descendants(root, limit: 4000) {
        let elementRole = role(element)
        let description = stringAttribute(element, kAXDescriptionAttribute as CFString) ?? ""
        let isDocumentLocation = elementRole == "AXWebArea"
            || (elementRole == (kAXTextFieldRole as String) && description.contains("地址"))
        guard isDocumentLocation else { continue }
        if let value = acceptable(stringAttribute(element, kAXURLAttribute as CFString)) { return value }
        if let value = acceptable(stringAttribute(element, kAXValueAttribute as CFString)) { return value }
    }
    return nil
}

func windowSignature(_ window: AXUIElement) -> String {
    let title = label(window) ?? ""
    let document = stringAttribute(window, kAXDocumentAttribute as CFString) ?? ""
    return "\(title)|\(document)"
}

func readPublicURL(
    app: AXUIElement,
    excluding known: Set<String>,
    knowledgeBeforeOpen: AXUIElement,
    expectsURL: Bool
) -> (AXUIElement, String?, Bool)? {
    var fallback: (AXUIElement, String?, Bool)? = nil
    let deadline = Date().addingTimeInterval(expectsURL ? 12 : 2)
    repeat {
        for window in windows(app).reversed()
            where !known.contains(windowSignature(window)) && pageKnowledgeID(window).isEmpty {
            if let url = publicURL(in: window) {
                return (window, url, CFEqual(window, knowledgeBeforeOpen))
            }
            let title = label(window) ?? ""
            if !title.isEmpty { fallback = (window, nil, CFEqual(window, knowledgeBeforeOpen)) }
        }
        pause(0.15)
    } while Date() < deadline
    return fallback
}

func closeArticlePage(app: AXUIElement, _ window: AXUIElement, reusedKnowledgeWindow: Bool) -> Bool {
    let openedSignature = windowSignature(window)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    if let owner = elementAttribute(window, kAXParentAttribute as CFString) {
        _ = AXUIElementSetAttributeValue(owner, kAXFocusedWindowAttribute as CFString, window)
    }
    pause(0.2)
    let keyCode: CGKeyCode = reusedKnowledgeWindow ? 33 : 13 // Command-[ goes back; Command-W closes a new tab/window.
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { return false }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return waitUntil(6) {
        knowledgeWindow(app) != nil && !windows(app).contains(where: { windowSignature($0) == openedSignature })
    }
}

func pageKnowledgeID(_ window: AXUIElement) -> String {
    for element in [window] + descendants(window, limit: 4000) {
        guard let value = stringAttribute(element, kAXURLAttribute as CFString),
              let range = value.range(of: "knowledgeBaseId=") else { continue }
        let suffix = value[range.upperBound...]
        return String(suffix.prefix { $0 != "&" && $0 != "#" })
    }
    return ""
}

func pageKnowledgeName(_ window: AXUIElement) -> String {
    for element in descendants(window, limit: 4000) {
        guard let value = stringAttribute(element, kAXURLAttribute as CFString),
              value.contains("knowledgeBaseId="), let name = label(element) else { continue }
        return name
    }
    return ""
}

func exactElements(_ root: AXUIElement, _ text: String) -> [AXUIElement] {
    return descendants(root).filter { label($0) == text }
}

func sidebarTextElements(_ window: AXUIElement) -> [AXUIElement] {
    let windowFrame = frame(window) ?? .zero
    return descendants(window).filter { element in
        guard role(element) == (kAXStaticTextRole as String),
              let text = label(element), text.count > 0, text.count < 100,
              let itemFrame = frame(element) else { return false }
        let inSidebar = itemFrame.midX < windowFrame.minX + min(430, windowFrame.width * 0.35)
        return inSidebar && !["个人知识库", "共享知识库", "订阅知识库"].contains(text)
    }
}

func navigateToKnowledge(app: AXUIElement) throws -> AXUIElement {
    if let existing = knowledgeWindow(app) { return existing }
    guard !windows(app).isEmpty else {
        throw DriverError(code: "IMA_NOT_RUNNING", message: "ima is running but has no visible window")
    }
    var knowledgeTab: AXUIElement? = nil
    var navigationWindow: AXUIElement? = nil
    _ = waitUntil(10) {
        for window in windows(app) {
            if let tab = exactElements(window, "知识库").first {
                knowledgeTab = tab
                navigationWindow = window
                return true
            }
        }
        return false
    }
    if let tab = knowledgeTab {
        if let window = navigationWindow {
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            _ = AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, window)
            pause(0.2)
        }
        _ = clickCenter(tab)
        _ = waitUntil(6) { knowledgeWindow(app) != nil }
    }
    if let selected = knowledgeWindow(app) { return selected }
    throw DriverError(code: "KNOWLEDGE_NOT_FOUND", message: "ima did not open its knowledge-base page")
}

func selectKnowledge(app: AXUIElement, window: AXUIElement) throws -> Candidate {
    let currentID = pageKnowledgeID(window)
    let currentName = pageKnowledgeName(window)
    if query == currentID {
        return Candidate(name: currentName, id: currentID, element: window)
    }
    // Exact visible-name lookup is restricted to knowledge-base rows.
    let exactMatches = sidebarTextElements(window).filter { label($0) == query }
    if exactMatches.count > 1 {
        throw DriverError(code: "AMBIGUOUS_KNOWLEDGE", message: "Multiple knowledge bases are named '\(query)'; use an ID")
    }
    if query == currentName {
        return Candidate(name: currentName, id: currentID, element: window)
    }
    if let element = exactMatches.first, press(element) {
        _ = waitUntil(4) {
            guard let current = knowledgeWindow(app) else { return false }
            return pageKnowledgeName(current) == query
        }
        let current = knowledgeWindow(app) ?? window
        let candidate = Candidate(name: pageKnowledgeName(current), id: pageKnowledgeID(current), element: element)
        if query == candidate.name { return candidate }
    }

    // ID lookup: visit sidebar rows and compare the ID exposed by ima's page URL.
    let visible = sidebarTextElements(window)
    var checked = Set<String>()
    for element in visible {
        guard let name = label(element) else { continue }
        let nodeID = (attribute(element, "ChromeAXNodeId" as CFString) as? NSNumber)?.stringValue
        let identity = nodeID ?? "\(CFHash(element)):\(name)"
        guard !checked.contains(identity), press(element) else { continue }
        checked.insert(identity)
        pause(0.8)
        let current = knowledgeWindow(app) ?? window
        let candidate = Candidate(name: pageKnowledgeName(current), id: pageKnowledgeID(current), element: element)
        if query == candidate.name || query == candidate.id { return candidate }
    }
    throw DriverError(code: "KNOWLEDGE_NOT_FOUND", message: "No knowledge base exactly matches '\(query)'")
}

let datePattern = try! NSRegularExpression(pattern: #"(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}|\d{1,2}/\d{1,2}"#)
let folderPattern = try! NSRegularExpression(pattern: #"^\d+\s*项(?:\s|$)"#)
let knownTypes = ["公众号", "网页", "PDF", "文档", "文件", "笔记", "视频", "音频", "图片"]

func firstMatch(_ regex: NSRegularExpression, _ value: String) -> Bool {
    return regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

func textValues(_ element: AXUIElement) -> [String] {
    var values: [String] = []
    for item in [element] + descendants(element, limit: 100) {
        if let value = label(item), !values.contains(value) { values.append(value) }
    }
    return values
}

struct Row {
    let element: AXUIElement
    let identity: String
    let bounds: CGRect
    let title: String
    let metadata: String
    let isFolder: Bool
}

struct FolderTarget {
    let title: String
    let identity: String
    let ordinal: Int
}

func rows(in window: AXUIElement) -> [Row] {
    var result: [Row] = []
    let groups = descendants(window)
        .filter { role($0) == (kAXGroupRole as String) }
        .sorted { descendants($0, limit: 100).count < descendants($1, limit: 100).count }
    for element in groups {
        let values = textValues(element).filter { $0.count < 240 }
        guard values.count >= 2 && values.count <= 7 else { continue }
        let folderMetadata = values.first(where: { firstMatch(folderPattern, $0) })
        let rowType = values.first(where: { value in knownTypes.contains(where: { value.hasPrefix($0) }) })
        let rowDate = values.first(where: { firstMatch(datePattern, $0) })
        let metadata: String
        let isFolder: Bool
        if let folderMetadata {
            metadata = folderMetadata
            isFolder = true
        } else if let rowType, let rowDate {
            metadata = "\(rowType) \(rowDate)"
            isFolder = false
        } else {
            continue
        }
        guard let title = values.first(where: {
            $0 != metadata && !knownTypes.contains($0) && !firstMatch(datePattern, $0)
                && !$0.hasPrefix("/") && $0 != "没有更多内容了"
        }) else { continue }
        let bounds = frame(element) ?? .zero
        let overlapsAcceptedRow = result.contains { accepted in
            guard accepted.title == title && accepted.metadata == metadata,
                  !accepted.bounds.isEmpty && !bounds.isEmpty else { return false }
            return accepted.bounds.contains(CGPoint(x: bounds.midX, y: bounds.midY))
                || bounds.contains(CGPoint(x: accepted.bounds.midX, y: accepted.bounds.midY))
        }
        if overlapsAcceptedRow { continue }
        let nodeID = (attribute(element, "ChromeAXNodeId" as CFString) as? NSNumber)?.stringValue
        let identity = nodeID ?? "\(CFHash(element)):\(title):\(metadata)"
        result.append(Row(
            element: element,
            identity: identity,
            bounds: bounds,
            title: title,
            metadata: metadata,
            isFolder: isFolder
        ))
    }
    return result
}

func scrollPage(_ window: AXUIElement) -> Bool {
    for element in descendants(window).reversed() where role(element) == (kAXScrollAreaRole as String) {
        let action = "AXScrollDownByPage" as CFString
        if actions(element).contains(action as String), AXUIElementPerformAction(element, action) == .success { return true }
        if let bar = elementAttribute(element, kAXVerticalScrollBarAttribute as CFString),
           let current = attribute(bar, kAXValueAttribute as CFString) as? NSNumber {
            let next = min(1, current.doubleValue + 0.72)
            if next > current.doubleValue + 0.001 {
                return AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success
            }
        }
    }
    return false
}

func scrollToTop(_ window: AXUIElement) {
    for element in descendants(window) where role(element) == (kAXScrollAreaRole as String) {
        if let bar = elementAttribute(element, kAXVerticalScrollBarAttribute as CFString) {
            _ = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: 0))
        }
    }
    pause(0.5)
}

func findFolderRow(app: AXUIElement, target: FolderTarget) -> Row? {
    guard let initial = knowledgeWindow(app) else { return nil }
    scrollToTop(initial)
    var visitedPages = Set<String>()
    var fallbackSeen = Set<String>()
    var matchingTitleSeen = 0
    while let window = knowledgeWindow(app) {
        let folders = rows(in: window).filter { $0.isFolder }
        let pageIdentity = rows(in: window).map(\.identity).sorted().joined(separator: "|")
        if visitedPages.contains(pageIdentity) { return nil }
        visitedPages.insert(pageIdentity)
        if let match = folders.first(where: { $0.identity == target.identity }) { return match }
        let newTitleMatches = folders.filter {
            $0.title == target.title && !fallbackSeen.contains($0.identity)
        }
        if target.ordinal >= matchingTitleSeen
            && target.ordinal < matchingTitleSeen + newTitleMatches.count {
            return newTitleMatches[target.ordinal - matchingTitleSeen]
        }
        for match in newTitleMatches { fallbackSeen.insert(match.identity) }
        matchingTitleSeen += newTitleMatches.count
        if !scrollPage(window) { return nil }
        pause(0.8)
    }
    return nil
}

func scrapeCurrentFolder(
    app: AXUIElement,
    knowledge: Candidate,
    folderPath: [String],
    folderTargets: inout [FolderTarget]
) throws -> [[String: Any]] {
    var output: [[String: Any]] = []
    var seen = Set<String>()
    var idleRounds = 0
    while idleRounds < 2 {
        guard let window = knowledgeWindow(app) else { break }
        let pageRows = rows(in: window)
        var foldersAdded = 0
        for folder in pageRows where folder.isFolder
            && !folderTargets.contains(where: { $0.identity == folder.identity }) {
            let ordinal = folderTargets.filter { $0.title == folder.title }.count
            folderTargets.append(FolderTarget(title: folder.title, identity: folder.identity, ordinal: ordinal))
            foldersAdded += 1
        }
        var added = 0
        for row in pageRows where !row.isFolder && !seen.contains(row.identity) {
            seen.insert(row.identity)
            added += 1
            let parts = row.metadata.split(separator: " ").map(String.init)
            let contentType = parts.first ?? ""
            let addedDate = parts.first(where: { firstMatch(datePattern, $0) }) ?? ""
            let before = Set(windows(app).map(windowSignature))
            guard let knowledgeBeforeOpen = knowledgeWindow(app) else {
                throw DriverError(code: "KNOWLEDGE_WINDOW_LOST", message: "Knowledge-base window disappeared")
            }
            var url: String? = nil
            let expectsURL = contentType == "公众号" || contentType == "网页"
            if press(row.element), let opened = readPublicURL(
                app: app,
                excluding: before,
                knowledgeBeforeOpen: knowledgeBeforeOpen,
                expectsURL: expectsURL
            ) {
                url = opened.1
                if !closeArticlePage(app: app, opened.0, reusedKnowledgeWindow: opened.2) {
                    throw DriverError(code: "TAB_CLOSE_FAILED", message: "Could not close article tab '\(row.title)' safely")
                }
            }
            output.append([
                "knowledgeBaseId": knowledge.id,
                "knowledgeBase": knowledge.name,
                "folderPath": folderPath,
                "title": row.title,
                "url": url ?? NSNull(),
                "contentType": contentType,
                "addedDate": addedDate
            ])
        }
        if added == 0 && foldersAdded == 0 { idleRounds += 1 } else { idleRounds = 0 }
        guard let current = knowledgeWindow(app), scrollPage(current) else { break }
        pause(0.8)
    }
    return output
}

func scrapeFolderRecursive(app: AXUIElement, knowledge: Candidate, folderPath: [String], depth: Int = 0) throws -> [[String: Any]] {
    guard depth < 20, knowledgeWindow(app) != nil else { return [] }
    var folderTargets: [FolderTarget] = []
    var output = try scrapeCurrentFolder(
        app: app,
        knowledge: knowledge,
        folderPath: folderPath,
        folderTargets: &folderTargets
    )
    for folderTarget in folderTargets {
        guard let folder = findFolderRow(app: app, target: folderTarget), press(folder.element) else {
            throw DriverError(code: "FOLDER_NAVIGATION_FAILED", message: "Could not open folder '\(folderTarget.title)'")
        }
        pause(1)
        output.append(contentsOf: try scrapeFolderRecursive(
            app: app,
            knowledge: knowledge,
            folderPath: folderPath + [folderTarget.title],
            depth: depth + 1
        ))
        let parentName = folderPath.last ?? knowledge.name
        guard let childWindow = knowledgeWindow(app),
              let parentCrumb = exactElements(childWindow, parentName).last,
              press(parentCrumb) else {
            throw DriverError(code: "FOLDER_NAVIGATION_FAILED", message: "Could not return to folder '\(parentName)'")
        }
        pause(1)
    }
    return output
}

func scrapeKnowledge(app: AXUIElement, knowledge: Candidate) throws -> [[String: Any]] {
    return try scrapeFolderRecursive(app: app, knowledge: knowledge, folderPath: [])
}

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    print(String(data: data, encoding: .utf8)!)
}

do {
    guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw DriverError(code: "EMPTY_QUERY", message: "Knowledge-base name or ID is required")
    }
    guard AXIsProcessTrusted() else {
        throw DriverError(code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Enable Accessibility access for the terminal running bycli")
    }
    let runningApps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
    guard !runningApps.isEmpty else {
        throw DriverError(code: "IMA_NOT_RUNNING", message: "Open ima before running this command")
    }
    var selected: (NSRunningApplication, AXUIElement)? = nil
    for running in runningApps where !running.isTerminated {
        let candidate = AXUIElementCreateApplication(running.processIdentifier)
        if !windows(candidate).isEmpty { selected = (running, candidate); break }
    }
    guard let (running, app) = selected else {
        throw DriverError(code: "IMA_NOT_RUNNING", message: "ima is running but has no visible window")
    }
    running.activate()
    let window = try navigateToKnowledge(app: app)
    let knowledge = try selectKnowledge(app: app, window: window)
    guard let contentWindow = knowledgeWindow(app),
          descendants(contentWindow).contains(where: { role($0) == "AXWebArea" }) else {
        throw DriverError(
            code: "ACCESSIBILITY_CONTENT_UNAVAILABLE",
            message: "ima's article list is not exposed to macOS Accessibility; quit ima and reopen it with --force-renderer-accessibility"
        )
    }
    let items = try scrapeKnowledge(app: app, knowledge: knowledge)
    emit(["ok": true, "knowledgeBaseId": knowledge.id, "knowledgeBase": knowledge.name, "items": items])
} catch let error as DriverError {
    emit(["ok": false, "code": error.code, "message": error.message])
} catch {
    emit(["ok": false, "code": "AX_DRIVER_FAILED", "message": String(describing: error)])
}
`;

export function parseDriverEnvelope(output) {
    const lines = String(output).trim().split(/\r?\n/).reverse();
    let envelope;
    for (const line of lines) {
        try {
            envelope = JSON.parse(line);
            break;
        } catch {
            // Swift may print compiler diagnostics around the single JSON result.
        }
    }
    if (!envelope || typeof envelope !== 'object') throw new Error('ima driver returned invalid JSON');
    if (typeof envelope.ok !== 'boolean') throw new Error('ima driver response is missing ok flag');
    return envelope;
}

export function readKnowledgeBase(query) {
    if (process.platform !== 'darwin') {
        return { ok: false, code: 'UNSUPPORTED_PLATFORM', message: 'The ima adapter currently requires macOS' };
    }
    try {
        execFileSync('pgrep', ['-x', 'ima.copilot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
        execFileSync('open', ['-a', 'ima.copilot', '--args', '--force-renderer-accessibility'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        execFileSync('osascript', ['-e', 'delay 2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    try {
        execFileSync('osascript', OPEN_KNOWLEDGE_APPLESCRIPT.flatMap((line) => ['-e', line]), {
            encoding: 'utf8',
            timeout: 15_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch {
        // The Swift driver below returns the actionable typed error.
    }
    const output = execFileSync('swift', ['-', String(query)], {
        input: AX_KNOWLEDGE_SCRIPT,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const envelope = parseDriverEnvelope(output);
    if (Array.isArray(envelope.items)) {
        envelope.items = envelope.items.map((item) => ({ ...item, url: normalizeArticleUrl(item.url) }));
    }
    return envelope;
}

export const __test__ = { AX_KNOWLEDGE_SCRIPT, OPEN_KNOWLEDGE_APPLESCRIPT };
