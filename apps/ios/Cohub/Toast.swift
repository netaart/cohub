import UIKit

@MainActor
enum Toast {
    static func show(_ text: String, in view: UIView?) {
        guard let view else { return }
        let label = UILabel()
        label.text = text
        label.numberOfLines = 2
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .systemBackground

        let pill = UIView()
        pill.backgroundColor = UIColor.label.withAlphaComponent(0.9)
        pill.layer.cornerRadius = 18
        pill.layer.cornerCurve = .continuous
        pill.alpha = 0
        pill.isUserInteractionEnabled = false
        pill.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        view.addSubview(pill)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 9),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -9),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -16),
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            pill.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
        UIAccessibility.post(notification: .announcement, argument: text)
        UIView.animate(withDuration: 0.2) { pill.alpha = 1 }
        UIView.animate(withDuration: 0.3, delay: 2.2, options: []) { pill.alpha = 0 } completion: { _ in pill.removeFromSuperview() }
    }
}
