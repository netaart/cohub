import UIKit

enum LaunchFailure: Equatable {
    case offline
    case broken

    init?(_ error: Error) {
        guard let error = error as? URLError else { return nil }
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost,
             .dnsLookupFailed, .timedOut, .dataNotAllowed, .internationalRoamingOff, .callIsActive:
            self = .offline
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
             .clientCertificateRejected, .clientCertificateRequired:
            self = .broken
        default:
            return nil
        }
    }
}

final class LaunchCover: UIView {
    enum State: Equatable {
        case loading
        case slow
        case failed(LaunchFailure)
    }

    var state = State.loading {
        didSet { if state != oldValue { render() } }
    }

    var failure: LaunchFailure? {
        if case .failed(let failure) = state { return failure }
        return nil
    }

    var onAction: (() -> Void)?

    var lifting: Bool { net.lifting }

    private let net = LaunchNet()
    private let title = UILabel()
    private let detail = UILabel()
    private let action = UIButton(configuration: .plain())
    private lazy var status = UIStackView(arrangedSubviews: [title, detail, action])

    init() {
        super.init(frame: .zero)
        accessibilityViewIsModal = true
        net.isAccessibilityElement = true
        net.accessibilityLabel = L("Loading")
        title.font = .preferredFont(forTextStyle: .headline)
        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.textColor = .secondaryLabel
        for label in [title, detail] {
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textAlignment = .center
        }
        action.addAction(UIAction { [weak self] _ in self?.onAction?() }, for: .primaryActionTriggered)
        status.axis = .vertical
        status.alignment = .center
        status.spacing = 16
        status.isHidden = true
        net.frame = bounds
        net.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(net)
        status.translatesAutoresizingMaskIntoConstraints = false
        addSubview(status)
        below.priority = .defaultHigh
        NSLayoutConstraint.activate([
            below,
            status.bottomAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
            status.centerXAnchor.constraint(equalTo: centerXAnchor),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            status.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private lazy var below = status.topAnchor.constraint(equalTo: centerYAnchor)

    override func layoutSubviews() {
        below.constant = net.clearance + 32
        super.layoutSubviews()
        net.clear(status.isHidden ? nil : status.frame)
    }

    func lift(_ done: @escaping () -> Void) {
        guard !lifting else { return }
        accessibilityViewIsModal = false
        accessibilityElementsHidden = true
        UIAccessibility.post(notification: .screenChanged, argument: nil)
        UIView.animate(withDuration: 0.15) { self.status.alpha = 0 }
        net.lift(done)
    }

    func hold() {
        status.layer.removeAllAnimations()
        status.alpha = 1
        accessibilityViewIsModal = true
        accessibilityElementsHidden = false
        net.hold()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard lifting else { return super.hitTest(point, with: event) }
        return net.reveals(convert(point, to: net)) ? nil : self
    }

    private func render() {
        switch state {
        case .loading:
            show(nil)
            net.phase = .loading
        case .slow:
            show(L("Taking longer than usual"), action: L("Reload"))
            net.phase = .slow
        case .failed(.offline):
            show(L("Can't reach Cohub"), note: L("Cohub will try again when you're back online."), action: L("Try again"), prominent: true)
            net.phase = .offline
        case .failed(.broken):
            show(L("Couldn't load Cohub"), action: L("Try again"), prominent: true)
            net.phase = .broken
        }
        net.isAccessibilityElement = failure == nil
    }

    private func show(_ heading: String?, note: String? = nil, action label: String? = nil, prominent: Bool = false) {
        let appearing = status.isHidden && heading != nil
        title.text = heading
        detail.text = note
        detail.isHidden = note == nil
        status.setCustomSpacing(note == nil ? 16 : 6, after: title)
        var button: UIButton.Configuration = prominent ? .filled() : .plain()
        button.title = label
        button.cornerStyle = .capsule
        action.configuration = button
        status.isHidden = heading == nil
        setNeedsLayout()
        guard appearing else { return }
        status.alpha = 0
        UIView.animate(withDuration: 0.2) { self.status.alpha = 1 }
    }
}
