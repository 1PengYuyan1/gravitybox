import Cocoa

final class AddAccountSheet: NSObject {
    static let sheetWidth: CGFloat = 460
    static let collapsedHeight: CGFloat = 294
    static let expandedHeight: CGFloat = 338

    unowned let app: Assistant
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: AddAccountSheet.sheetWidth, height: AddAccountSheet.collapsedHeight),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    let status = text("", size: 12, color: Design.secondary, wrap: true)
    let spinner = NSProgressIndicator()
    let currentButton = button(L10n.t("add_account.save_current", fallback: "保存当前账号"), target: nil, action: #selector(saveCurrent))
    let cancelButton = button(L10n.t("common.cancel", fallback: "取消"), target: nil, action: #selector(cancel))
    private var feedback: NSStackView!
    private var languageObserver: NSObjectProtocol?
    private var headerTitleLabel: NSTextField!
    private var saveCurrentTitleLabel: NSTextField!
    private var saveCurrentSubLabel: NSTextField!
    private var saveEmailCopyTitle: NSTextField?
    private var contentViewRef: NSView?
    var closing = false
    var saved: () -> Void
    var onDismiss: (() -> Void)?

    init(app: Assistant, saved: @escaping () -> Void) {
        self.app = app
        self.saved = saved
        super.init()
        window.title = L10n.t("add_account.title", fallback: "添加账号")
        window.isReleasedWhenClosed = false
        currentButton.target = self
        // 单卡确认模式：展示当前已登录的 Antigravity 账号并将即开即用的“保存当前账号”置为底部右对齐主按钮。
        let currentEmail = app.statusValue.liveAccountEmail.isEmpty ? app.statusValue.activeAccountEmail : app.statusValue.liveAccountEmail
        currentButton.title = L10n.t("add_account.save_current", fallback: "保存当前账号")
        currentButton.isEnabled = true
        currentButton.bezelColor = Design.blue
        currentButton.keyEquivalent = "\r"
        currentButton.setAccessibilityLabel(currentButton.title)
        cancelButton.title = L10n.t("common.cancel", fallback: "取消")
        cancelButton.target = self
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityLabel(cancelButton.title)
        window.initialFirstResponder = currentButton

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 16),
            spinner.heightAnchor.constraint(equalToConstant: 16)
        ])

        let titleLbl = text(L10n.t("add_account.current_card_title", fallback: "当前 Antigravity 账号"), size: 13, weight: .semibold, color: .labelColor)
        let subLbl = text(L10n.t("add_account.save_current_only_sub", fallback: "将导入当前 Antigravity 已登录的账号；如需添加多个账号，请先在 Antigravity 中切换登录后再导入。"), size: 11, color: Design.secondary, wrap: true)
        subLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
        subLbl.setContentHuggingPriority(.required, for: .vertical)
        subLbl.setContentCompressionResistancePriority(.required, for: .vertical)
        var textViews: [NSView] = [titleLbl, subLbl]
        if !currentEmail.isEmpty {
            let emailLbl = text(currentEmail, size: 10.5, color: .secondaryLabelColor)
            enableTextCopy(emailLbl, title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"))
            emailLbl.font = .systemFont(ofSize: 11.5, weight: .regular)
            emailLbl.lineBreakMode = .byTruncatingMiddle
            emailLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            emailLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            saveEmailCopyTitle = emailLbl
            textViews.append(emailLbl)
        }
        let textCol = vertical(textViews, spacing: 2.5)
        textCol.alignment = .leading
        textCol.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        textCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for v in textViews {
            v.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            fillWidth(v, in: textCol)
        }
        let cardRow = horizontal([iconBadge("person.crop.rectangle", tint: Design.blue, size: 30), textCol], spacing: 12)
        cardRow.alignment = .centerY
        let saveCard = group([cardRow], inset: 14)
        saveCard.setContentHuggingPriority(.required, for: .vertical)
        saveCard.setContentCompressionResistancePriority(.required, for: .vertical)
        saveCurrentTitleLabel = titleLbl
        saveCurrentSubLabel = subLbl

        status.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        status.setContentHuggingPriority(.required, for: .vertical)
        status.setContentCompressionResistancePriority(.required, for: .vertical)
        feedback = horizontal([spinner, status], spacing: 8)
        feedback.isHidden = true
        let headerBadge = iconBadge("person.badge.plus", tint: Design.blue, size: 32)
        let headerTitle = text(L10n.t("add_account.title", fallback: "添加账号"), size: 16, weight: .semibold, color: .labelColor)
        headerTitleLabel = headerTitle
        let headerRow = horizontal([headerBadge, headerTitle, flexibleSpace()], spacing: 10)
        headerRow.alignment = .centerY

        let footer = horizontal([flexibleSpace(), cancelButton, currentButton], spacing: 8)
        footer.alignment = .centerY

        let root = vertical([headerRow, saveCard, feedback, footer], spacing: 12)
        root.detachesHiddenViews = true
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        contentViewRef = content
        surface.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        let contentBottom = content.bottomAnchor.constraint(equalTo: surface.bottomAnchor)
        contentBottom.priority = .defaultHigh
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
            content.topAnchor.constraint(equalTo: surface.topAnchor),
            contentBottom
        ])
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
        resizeSheetToFit()
        languageObserver = NotificationCenter.default.addObserver(
            forName: L10n.didChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            if Thread.isMainThread {
                self?.syncLocalizedChrome()
            } else {
                DispatchQueue.main.async { [weak self] in self?.syncLocalizedChrome() }
            }
        }
    }

    deinit {
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
    }

    private static func syncWrappingLabelWidths(in view: NSView) {
        if let tf = view as? NSTextField, !tf.isEditable, tf.cell?.wraps == true, !tf.isHidden, tf.bounds.width > 1 {
            // NSTextFieldCell 左右共保留约 4pt 内边距，按可绘制文本宽设置换行上限避免末行被裁剪
            let targetW = max(1, floor(tf.bounds.width) - 4)
            if abs(tf.preferredMaxLayoutWidth - targetW) > 0.5 {
                tf.preferredMaxLayoutWidth = targetW
            }
            tf.invalidateIntrinsicContentSize()
        }
        for sub in view.subviews {
            syncWrappingLabelWidths(in: sub)
        }
    }

    private func resizeSheetToFit() {
        guard let surface = window.contentView, let content = contentViewRef else { return }
        if abs(surface.frame.width - Self.sheetWidth) > 0.5 {
            surface.frame.size.width = Self.sheetWidth
        }
        surface.layoutSubtreeIfNeeded()
        Self.syncWrappingLabelWidths(in: surface)
        surface.layoutSubtreeIfNeeded()
        let targetH = max(1, ceil(content.fittingSize.height))
        if abs(surface.frame.width - Self.sheetWidth) > 0.5 || abs(surface.frame.height - targetH) > 0.5 {
            window.setContentSize(NSSize(width: Self.sheetWidth, height: targetH))
        }
        surface.layoutSubtreeIfNeeded()
    }

    private func syncLocalizedChrome() {
        let title = L10n.t("add_account.title", fallback: "添加账号")
        window.title = title
        headerTitleLabel.stringValue = title
        saveCurrentTitleLabel.stringValue = L10n.t("add_account.current_card_title", fallback: "当前 Antigravity 账号")
        saveCurrentSubLabel.stringValue = L10n.t("add_account.save_current_only_sub", fallback: "将导入当前 Antigravity 已登录的账号；如需添加多个账号，请先在 Antigravity 中切换登录后再导入。")
        currentButton.title = L10n.t("add_account.save_current", fallback: "保存当前账号")
        currentButton.setAccessibilityLabel(currentButton.title)
        cancelButton.title = L10n.t("common.cancel", fallback: "取消")
        cancelButton.setAccessibilityLabel(cancelButton.title)
        if let saveEmailCopyTitle {
            enableTextCopy(saveEmailCopyTitle, title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"))
        }
        resizeSheetToFit()
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        resizeSheetToFit()
        app.presentRetainedSheet(controller: self, sheet: window, in: parent) { [weak self] _ in
            self?.onDismiss?()
        }
        // F06: Sheet 成为 key 后再锁定一次初始焦点，避免 AppKit 按视图顺序落到次级按钮。
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window.sheetParent != nil else { return }
            self.window.makeFirstResponder(self.currentButton)
        }
    }

    func busy(_ value: Bool) {
        feedback.isHidden = status.stringValue.isEmpty
        resizeSheetToFit()
        currentButton.isEnabled = !value
        spinner.isHidden = !value
        if value {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
    }

    func fail(_ message: String) {
        status.stringValue = message
        status.textColor = accessibleDangerColor()
        busy(false)
        cancelButton.isEnabled = true
    }

    @objc func saveCurrent() {
        status.stringValue = L10n.t("add_account.status.reading_current")
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_save_current"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success:
                self.saved()
                self.dismiss()
            case .failure(let error):
                self.fail(error.localizedDescription)
            }
        }
    }

    @objc func cancel() {
        guard cancelButton.isEnabled, !closing else { return }
        dismiss()
    }

    func dismiss() {
        window.sheetParent?.endSheet(window)
    }
}
