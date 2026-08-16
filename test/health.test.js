const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const server = require('./helpers/server')

let baseUrl

before(async () => { baseUrl = await server.start() })
after(async () => { await server.stop() })

test('GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
})
