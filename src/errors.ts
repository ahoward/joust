// --- structured error types ---

export class JoustError extends Error {
  constructor(message: string, public readonly exit_code: number = 1) {
    super(message);
    this.name = "JoustError";
  }
}

export class JoustUserError extends JoustError {
  constructor(message: string) {
    super(message, 1);
    this.name = "JoustUserError";
  }
}
