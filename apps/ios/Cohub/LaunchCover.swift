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

    private static let spinKey = "spin"
    private let mark = UIImageView(image: UIImage(named: "LaunchMark"))
    private let title = UILabel()
    private let detail = UILabel()
    private let action = UIButton(configuration: .plain())
    private lazy var status = UIStackView(arrangedSubviews: [title, detail, action])

    init() {
        super.init(frame: .zero)
        backgroundColor = UIColor(named: "LaunchBackground")
        let tile = UIImageView(image: UIImage(named: "LaunchTile"))
        accessibilityViewIsModal = true
        mark.accessibilityLabel = L("Loading")
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
        for view in [tile, mark, status] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        let below = status.topAnchor.constraint(equalTo: tile.bottomAnchor, constant: 32)
        below.priority = .defaultHigh
        NSLayoutConstraint.activate([
            tile.centerXAnchor.constraint(equalTo: centerXAnchor),
            tile.centerYAnchor.constraint(equalTo: centerYAnchor),
            mark.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
            below,
            status.bottomAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
            status.centerXAnchor.constraint(equalTo: centerXAnchor),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            status.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        mark.layer.removeAnimation(forKey: Self.spinKey)
        render()
    }

    private func render() {
        switch state {
        case .loading:
            show(nil)
        case .slow:
            show(L("Taking longer than usual"), action: L("Reload"))
        case .failed(.offline):
            show(L("Can't reach Cohub"), note: L("Cohub will try again when you're back online."), action: L("Try again"), prominent: true)
        case .failed(.broken):
            show(L("Couldn't load Cohub"), action: L("Try again"), prominent: true)
        }
        spin(failure == nil && window != nil)
        mark.isAccessibilityElement = failure == nil
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
        guard appearing else { return }
        status.alpha = 0
        UIView.animate(withDuration: 0.2) { self.status.alpha = 1 }
    }

    private func spin(_ on: Bool) {
        let layer = mark.layer
        guard on else { return layer.removeAnimation(forKey: Self.spinKey) }
        guard layer.animation(forKey: Self.spinKey) == nil else { return }
        let turn = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        turn.values = [0, 2 * Double.pi, 2 * Double.pi]
        turn.keyTimes = [0, NSNumber(value: 2.0 / 3), 1]
        turn.timingFunctions = [CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1), CAMediaTimingFunction(name: .linear)]
        turn.duration = UIAccessibility.isReduceMotionEnabled ? 2.4 : 0.9
        turn.repeatCount = .infinity
        turn.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + 0.3
        turn.isRemovedOnCompletion = false
        layer.add(turn, forKey: Self.spinKey)
    }
}
