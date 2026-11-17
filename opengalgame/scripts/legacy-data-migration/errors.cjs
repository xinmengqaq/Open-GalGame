'use strict'

class MigrationError extends Error {
  constructor(message, { exitCode = 2, details } = {}) {
    super(message)
    this.name = 'MigrationError'
    this.exitCode = exitCode
    this.details = details
  }
}

module.exports = { MigrationError }
