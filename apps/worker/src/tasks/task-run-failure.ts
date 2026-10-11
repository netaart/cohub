/** Task failure that also records a structured result on the failed task run. */
export class TaskRunFailure<TResult extends Record<string, unknown> = Record<string, unknown>> extends Error {
  readonly result: TResult;

  constructor(message: string, result: TResult) {
    super(message);
    this.name = "TaskRunFailure";
    this.result = result;
  }
}
