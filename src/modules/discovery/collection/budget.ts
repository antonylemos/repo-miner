export class BudgetExhaustedError extends Error {
  constructor(public readonly reason: 'request_budget' | 'duration_budget') {
    super(reason);
    this.name = 'BudgetExhaustedError';
  }
}
