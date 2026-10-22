/** Thrown for every invalid input the engine rejects (validation, bad data, bad snapshots). */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
