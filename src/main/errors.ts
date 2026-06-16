/**
 * Application error carrying a stable `code`. The IPC registry reads `.code` and
 * surfaces `.message` to the renderer (which shows it verbatim — keep messages
 * plain-language, NU-02).
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Your session has ended. Please log in again.'),
  forbidden: () => new AppError('FORBIDDEN', 'You do not have permission to do that.'),
  authFailed: () => new AppError('AUTH_FAILED', 'Incorrect username or password.'),
  notFound: (what = 'item') => new AppError('NOT_FOUND', `That ${what} could not be found.`),
  conflict: (message: string) => new AppError('CONFLICT', message),
  validation: (message: string) => new AppError('VALIDATION', message),
} as const;
