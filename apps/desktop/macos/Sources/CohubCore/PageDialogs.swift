@MainActor
public final class PageDialogs {
    public typealias Answer = @MainActor @Sendable (String?) -> Void

    private var open: (id: Int, dismiss: @MainActor () -> Void, finish: Answer)?
    private var opened = 0

    public init() {}

    public func show(present: (_ answer: @escaping Answer) -> Void, dismiss: @escaping @MainActor () -> Void, finish: @escaping Answer) {
        guard open == nil else { return finish(nil) }
        opened += 1
        let id = opened
        open = (id, dismiss, finish)
        present { [self] answer in settle(id, answer) }
    }

    public func show(present: (_ answer: @escaping Answer) -> Void, dismiss: @escaping @MainActor () -> Void) async -> String? {
        await withCheckedContinuation { continuation in
            show(present: present, dismiss: dismiss, finish: { continuation.resume(returning: $0) })
        }
    }

    public func cancel() {
        guard let open else { return }
        settle(open.id, nil)
        open.dismiss()
    }

    private func settle(_ id: Int, _ answer: String?) {
        guard let open, open.id == id else { return }
        self.open = nil
        open.finish(answer)
    }
}
