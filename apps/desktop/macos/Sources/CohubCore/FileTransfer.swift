import Foundation

public enum FileTransfer {
    public typealias Progress = @Sendable (_ received: Int64, _ total: Int64?) -> Void

    static let progressInterval: TimeInterval = 0.25

    public static func download(_ request: URLRequest, to destination: URL, progress: @escaping Progress) async throws {
        let delegate = Delegate(destination: destination, progress: progress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                delegate.start(continuation)
                session.downloadTask(with: request).resume()
            }
        } onCancel: {
            session.invalidateAndCancel()
        }
    }

    public static func progressEvent(id: String, received: Int64, total: Int64?) -> JSON {
        ["id": .string(id), "received": .number(Double(received)), "total": total.map { .number(Double($0)) } ?? .null]
    }

    private final class Delegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        private let destination: URL
        private let progress: Progress
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Error>?
        private var failure: Error?
        private var reportedAt = Date.distantPast

        init(destination: URL, progress: @escaping Progress) {
            self.destination = destination
            self.progress = progress
        }

        func start(_ continuation: CheckedContinuation<Void, Error>) {
            lock.withLock { self.continuation = continuation }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            let now = Date()
            let due = lock.withLock {
                guard now.timeIntervalSince(reportedAt) >= FileTransfer.progressInterval else { return false }
                reportedAt = now
                return true
            }
            if due { progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            do {
                guard let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else { throw URLError(.badServerResponse) }
                try FileManager.default.moveItem(at: location, to: destination)
            } catch {
                lock.withLock { failure = error }
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            let (continuation, failure) = lock.withLock {
                defer { self.continuation = nil }
                return (self.continuation, self.failure)
            }
            if let error = error ?? failure { continuation?.resume(throwing: error) } else { continuation?.resume() }
        }
    }
}
