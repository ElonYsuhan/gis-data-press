import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LanUsers } from '../server/lan-users'

test('local profiles exchange text and retain independent histories after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lan-users-'))
  let users = new LanUsers(directory)
  try {
    await users.start()
    const first = users.snapshot().self.id
    await users.create('测试用户 B')
    const second = users.snapshot().users.find((u) => u.id !== first)!.id
    await users.current.sendText(second, '来自 A')
    await users.switch(second)
    assert.equal(users.snapshot().messages[0]?.text, '来自 A')
    assert.equal(users.snapshot().messages[0]?.direction, 'in')
    await users.current.sendText(first, '来自 B')
    await assert.rejects(users.create('测试用户 B'))
    await users.close()
    users = new LanUsers(directory)
    await users.start()
    assert.equal(users.snapshot().self.id, second)
    assert.equal(users.snapshot().messages.length, 2)
    await users.switch(first)
    assert.equal(users.snapshot().messages[1]?.text, '来自 B')
  } finally {
    await users.close()
    await rm(directory, { recursive: true, force: true })
  }
})
