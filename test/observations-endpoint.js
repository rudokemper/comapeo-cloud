import { MapeoManager } from '@comapeo/core'
import { valueOf } from '@comapeo/schema'
import { keyToPublicId as projectKeyToPublicId } from '@mapeo/crypto'
import { generate } from '@mapeo/mock-data'
import { map } from 'iterpal'

import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import test from 'node:test'

import {
  BEARER_TOKEN,
  createTestServer,
  getManagerOptions,
  randomAddProjectBody,
  randomProjectPublicId,
  runWithRetries,
} from './test-helpers.js'

/** @import { ObservationValue } from '@comapeo/schema'*/
/** @import { FastifyInstance } from 'fastify' */

const FIXTURES_ROOT = new URL('./fixtures/', import.meta.url)
const FIXTURE_ORIGINAL_PATH = new URL('original.jpg', FIXTURES_ROOT).pathname
const FIXTURE_PREVIEW_PATH = new URL('preview.jpg', FIXTURES_ROOT).pathname
const FIXTURE_THUMBNAIL_PATH = new URL('thumbnail.jpg', FIXTURES_ROOT).pathname
const FIXTURE_AUDIO_PATH = new URL('audio.mp3', FIXTURES_ROOT).pathname

test('returns a 401 if no auth is provided', async (t) => {
  const server = createTestServer(t)

  const response = await server.inject({
    method: 'GET',
    url: `/projects/${randomProjectPublicId()}/observations`,
  })
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'UNAUTHORIZED')
})

test('returns a 401 if incorrect auth is provided', async (t) => {
  const server = createTestServer(t)

  const response = await server.inject({
    method: 'GET',
    url: `/projects/${randomProjectPublicId()}/observations`,
    headers: { Authorization: 'Bearer bad' },
  })
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'UNAUTHORIZED')
})

test('returning no observations', async (t) => {
  const server = createTestServer(t)
  const projectKeys = randomAddProjectBody()
  const projectPublicId = projectKeyToPublicId(
    Buffer.from(projectKeys.projectKey, 'hex'),
  )

  const addProjectResponse = await server.inject({
    method: 'PUT',
    url: '/projects',
    body: projectKeys,
  })
  assert.equal(addProjectResponse.statusCode, 200)

  const response = await server.inject({
    method: 'GET',
    url: `/projects/${projectPublicId}/observations`,
    headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(await response.json(), { data: [] })
})

test('returning observations with fetchable attachments', async (t) => {
  const server = createTestServer(t)

  const serverAddress = await server.listen()
  const serverUrl = new URL(serverAddress)

  const manager = new MapeoManager(getManagerOptions())
  const projectId = await manager.createProject({ name: 'CoMapeo project' })
  const project = await manager.getProject(projectId)

  await project.$member.addServerPeer(serverAddress, {
    dangerouslyAllowInsecureConnections: true,
  })

  project.$sync.start()
  project.$sync.connectServers()

  const observations = await Promise.all([
    (() => {
      /** @type {ObservationValue} */
      // @ts-ignore
      const noAttachments = {
        ...generateObservation(),
        attachments: [],
      }
      return project.observation.create(noAttachments)
    })(),
    (async () => {
      // @ts-ignore
      const { docId } = await project.observation.create(generateObservation())
      return project.observation.delete(docId)
    })(),
    (async () => {
      const [imageBlob, audioBlob] = await Promise.all([
        project.$blobs.create(
          {
            original: FIXTURE_ORIGINAL_PATH,
            preview: FIXTURE_PREVIEW_PATH,
            thumbnail: FIXTURE_THUMBNAIL_PATH,
          },
          { mimeType: 'image/jpeg', timestamp: Date.now() },
        ),
        project.$blobs.create(
          { original: FIXTURE_AUDIO_PATH },
          { mimeType: 'audio/mpeg', timestamp: Date.now() },
        ),
      ])
      /** @type {ObservationValue} */
      // @ts-ignore
      const withAttachment = {
        ...generateObservation(),
        attachments: [blobToAttachment(imageBlob), blobToAttachment(audioBlob)],
      }
      return project.observation.create(withAttachment)
    })(),
  ])

  await project.$sync.waitForSync('full')

  // It's possible that the client thinks it's synced but the server hasn't
  // processed everything yet, so we try a few times.
  const data = await runWithRetries(3, async () => {
    const response = await server.inject({
      authority: serverUrl.host,
      method: 'GET',
      url: `/projects/${projectId}/observations`,
      headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
    })
    assert.equal(response.statusCode, 200)

    const { data } = await response.json()
    assert.equal(data.length, 3)
    return data
  })

  await Promise.all(
    observations.map(async (observation) => {
      const observationFromApi = data.find(
        (/** @type {{ docId: string }} */ o) => o.docId === observation.docId,
      )
      assert(observationFromApi, 'observation found in API response')
      assert.equal(observationFromApi.createdAt, observation.createdAt)
      assert.equal(observationFromApi.updatedAt, observation.updatedAt)
      assert.equal(observationFromApi.lat, observation.lat)
      assert.equal(observationFromApi.lon, observation.lon)
      assert.equal(observationFromApi.deleted, observation.deleted)
      if (!observationFromApi.deleted) {
        await assertAttachmentsCanBeFetchedAsJpeg({
          server,
          serverAddress,
          observationFromApi,
        })
      }
      assert.deepEqual(observationFromApi.tags, observation.tags)
    }),
  )
})

function generateObservation() {
  const observationDoc = generate('observation')[0]
  assert(observationDoc)
  return valueOf(observationDoc)
}

/**
 * @param {object} blob
 * @param {string} blob.driveId
 * @param {'photo' | 'audio' | 'video'} blob.type
 * @param {string} blob.name
 * @param {string} blob.hash
 */
function blobToAttachment(blob) {
  return {
    driveDiscoveryId: blob.driveId,
    type: blob.type,
    name: blob.name,
    hash: blob.hash,
  }
}

/**
 * @param {object} options
 * @param {FastifyInstance} options.server
 * @param {string} options.serverAddress
 * @param {Record<string, unknown>} options.observationFromApi
 * @returns {Promise<void>}
 */
async function assertAttachmentsCanBeFetchedAsJpeg({
  server,
  serverAddress,
  observationFromApi,
}) {
  assert(Array.isArray(observationFromApi.attachments))
  await Promise.all(
    observationFromApi.attachments.map(
      /** @param {unknown} attachment */
      async (attachment) => {
        assert(attachment && typeof attachment === 'object')
        assert('url' in attachment && typeof attachment.url === 'string')
        await assertAttachmentAndVariantsCanBeFetched(
          server,
          serverAddress,
          attachment.url,
        )
      },
    ),
  )
}

/**
 * @param {FastifyInstance} server
 * @param {string} serverAddress
 * @param {string} url
 * @returns {Promise<void>}
 */
async function assertAttachmentAndVariantsCanBeFetched(
  server,
  serverAddress,
  url,
) {
  assert(url.startsWith(serverAddress))

  /** @type {Map<null | string, string>} */
  const variantsToCheck = new Map([
    [null, FIXTURE_ORIGINAL_PATH],
    ['original', FIXTURE_ORIGINAL_PATH],
    ['preview', FIXTURE_PREVIEW_PATH],
    ['thumbnail', FIXTURE_THUMBNAIL_PATH],
  ])

  await Promise.all(
    map(variantsToCheck, async ([variant, fixturePath]) => {
      const expectedResponseBodyPromise = fs.readFile(fixturePath)
      const attachmentResponse = await server.inject({
        method: 'GET',
        url: url + (variant ? `?variant=${variant}` : ''),
        headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
      })
      assert.equal(
        attachmentResponse.statusCode,
        200,
        `expected 200 when fetching ${variant} attachment`,
      )
      assert.equal(
        attachmentResponse.headers['content-type'],
        'image/jpeg',
        `expected ${variant} attachment to be a JPEG`,
      )
      assert.deepEqual(
        attachmentResponse.rawPayload,
        await expectedResponseBodyPromise,
        `expected ${variant} attachment to match fixture`,
      )
    }),
  )
}
