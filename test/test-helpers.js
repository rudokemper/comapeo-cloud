import {
  KeyManager,
  keyToPublicId as projectKeyToPublicId,
} from '@mapeo/crypto'
import createFastify from 'fastify'
import RAM from 'random-access-memory'

import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import comapeoServer from '../src/app.js'

/** @import { MapeoManager } from '@comapeo/core' */
/** @import { TestContext } from 'node:test' */
/** @import { FastifyInstance } from 'fastify' */
/** @import { ServerOptions } from '../src/app.js' */

export const BEARER_TOKEN = Buffer.from('swordfish').toString('base64')

const TEST_SERVER_DEFAULTS = {
  serverName: 'test server',
  serverBearerToken: BEARER_TOKEN,
}

/**
 * @returns {ConstructorParameters<typeof MapeoManager>[0]}
 */
export function getManagerOptions() {
  const comapeoCoreUrl = new URL(
    '../node_modules/@comapeo/core/',
    import.meta.url,
  )
  const projectMigrationsFolder = new URL('./drizzle/project', comapeoCoreUrl)
    .pathname
  const clientMigrationsFolder = new URL('./drizzle/client', comapeoCoreUrl)
    .pathname
  return {
    rootKey: randomBytes(16),
    projectMigrationsFolder,
    clientMigrationsFolder,
    dbFolder: ':memory:',
    coreStorage: () => new RAM(),
    fastify: createFastify(),
  }
}

/**
 * @param {TestContext} t
 * @param {Partial<ServerOptions>} [serverOptions]
 * @returns {FastifyInstance & { deviceId: string }}
 */
export function createTestServer(t, serverOptions) {
  const managerOptions = getManagerOptions()
  const km = new KeyManager(managerOptions.rootKey)
  const server = createFastify()
  server.register(comapeoServer, {
    ...managerOptions,
    ...TEST_SERVER_DEFAULTS,
    ...serverOptions,
  })
  t.after(() => server.close())
  Object.defineProperty(server, 'deviceId', {
    get() {
      return km.getIdentityKeypair().publicKey.toString('hex')
    },
  })
  // @ts-expect-error
  return server
}

export const randomHex = (length = 32) =>
  Buffer.from(randomBytes(length)).toString('hex')

export const randomAddProjectBody = () => ({
  projectName: randomHex(16),
  projectKey: randomHex(),
  encryptionKeys: {
    auth: randomHex(),
    config: randomHex(),
    data: randomHex(),
    blobIndex: randomHex(),
    blob: randomHex(),
  },
})

export const randomProjectPublicId = () => projectKeyToPublicId(randomBytes(32))

/**
 * @template {object} T
 * @template {keyof T} K
 * @param {T} obj
 * @param {K} key
 * @returns {Omit<T, K>}
 */
export function omit(obj, key) {
  const result = { ...obj }
  delete result[key]
  return result
}

/**
 * @template T
 * @param {number} retries
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runWithRetries(retries, fn) {
  for (let i = 0; i < retries - 1; i++) {
    try {
      return await fn()
    } catch {
      await delay(500)
    }
  }
  return fn()
}
