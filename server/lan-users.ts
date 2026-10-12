import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { LanChat } from './lan'

/** Each local profile owns a real endpoint and separate history. */
export class LanUsers {
  private users: { key: string; name?: string; chat: LanChat }[] = []
  private active = ''
  private timer?: ReturnType<typeof setInterval>
  constructor(private directory: string) {}
  get current() {
    return this.users.find((u) => u.key === this.active)!.chat
  }
  async start() {
    let saved: { active: string; users: { key: string; name?: string }[] } = {
      active: 'default',
      users: [{ key: 'default' }],
    }
    try {
      saved = JSON.parse(await readFile(path.join(this.directory, 'users.json'), 'utf8'))
    } catch {}
    for (const user of saved.users) {
      await this.add(user.key, user.name)
    }
    this.active = this.users.some((u) => u.key === saved.active) ? saved.active : this.users[0]!.key
    await this.connectLocal()
    this.timer = setInterval(() => {
      void this.connectLocal().catch(() => {})
    }, 2000)
  }
  private async add(key: string, name?: string) {
    const chat = new LanChat(key === 'default' ? this.directory : path.join(this.directory, key), {
      loopback: true,
      name,
    })
    await chat.start()
    this.users.push({ key, name, chat })
  }
  private async connectLocal() {
    for (const user of this.users) {
      for (const other of this.users) {
        if (user !== other) {
          await user.chat.connect('127.0.0.1', other.chat.endpoint())
        }
      }
    }
  }
  private async save() {
    await writeFile(
      path.join(this.directory, 'users.json'),
      JSON.stringify({
        active: this.active,
        users: this.users.map(({ key, name }) => ({ key, name })),
      }),
    )
  }
  async create(name: string) {
    name = name.trim()
    if (!name || name.length > 32) {
      throw new Error('请输入 1–32 字的用户名')
    }
    if (this.users.some((u) => u.chat.snapshot().self.name === name)) {
      throw new Error('用户名已存在')
    }
    await this.add(randomUUID(), name)
    await this.connectLocal()
    await this.save()
  }
  async switch(id: string) {
    const user = this.users.find((u) => u.chat.id === id)
    if (!user) {
      throw new Error('用户不存在')
    }
    this.active = user.key
    await this.save()
  }
  snapshot() {
    return { ...this.current.snapshot(), users: this.users.map((u) => u.chat.snapshot().self) }
  }
  async close() {
    clearInterval(this.timer)
    await Promise.all(this.users.map((u) => u.chat.close()))
  }
}
