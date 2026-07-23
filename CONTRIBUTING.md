# Contributing

1. Open an issue describing the behavior or proposed change.
2. Create a branch and keep credentials outside the repository.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm audit`.
4. Submit a focused pull request with tests where practical.

Destructive tools must be recoverable where possible and require an explicit confirmation argument.
New read operations must include pagination or a bounded response.
