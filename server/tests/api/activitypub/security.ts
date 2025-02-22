/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { buildDigest } from '@server/helpers/peertube-crypto'
import { HTTP_SIGNATURE } from '@server/initializers/constants'
import { activityPubContextify } from '@server/lib/activitypub/context'
import { buildGlobalHeaders, signAndContextify } from '@server/lib/activitypub/send'
import { makeFollowRequest, makePOSTAPRequest } from '@server/tests/shared'
import { buildAbsoluteFixturePath, wait } from '@shared/core-utils'
import { HttpStatusCode } from '@shared/models'
import { cleanupTests, createMultipleServers, killallServers, PeerTubeServer } from '@shared/server-commands'

function setKeysOfServer (onServer: PeerTubeServer, ofServer: PeerTubeServer, publicKey: string, privateKey: string) {
  const url = 'http://localhost:' + ofServer.port + '/accounts/peertube'

  return Promise.all([
    onServer.sql.setActorField(url, 'publicKey', publicKey),
    onServer.sql.setActorField(url, 'privateKey', privateKey)
  ])
}

function setUpdatedAtOfServer (onServer: PeerTubeServer, ofServer: PeerTubeServer, updatedAt: string) {
  const url = 'http://localhost:' + ofServer.port + '/accounts/peertube'

  return Promise.all([
    onServer.sql.setActorField(url, 'createdAt', updatedAt),
    onServer.sql.setActorField(url, 'updatedAt', updatedAt)
  ])
}

function getAnnounceWithoutContext (server: PeerTubeServer) {
  const json = require(buildAbsoluteFixturePath('./ap-json/peertube/announce-without-context.json'))
  const result: typeof json = {}

  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key])) {
      result[key] = json[key].map(v => v.replace(':9002', `:${server.port}`))
    } else {
      result[key] = json[key].replace(':9002', `:${server.port}`)
    }
  }

  return result
}

describe('Test ActivityPub security', function () {
  let servers: PeerTubeServer[]
  let url: string

  const keys = require(buildAbsoluteFixturePath('./ap-json/peertube/keys.json'))
  const invalidKeys = require(buildAbsoluteFixturePath('./ap-json/peertube/invalid-keys.json'))
  const baseHttpSignature = () => ({
    algorithm: HTTP_SIGNATURE.ALGORITHM,
    authorizationHeaderName: HTTP_SIGNATURE.HEADER_NAME,
    keyId: 'acct:peertube@localhost:' + servers[1].port,
    key: keys.privateKey,
    headers: HTTP_SIGNATURE.HEADERS_TO_SIGN
  })

  // ---------------------------------------------------------------

  before(async function () {
    this.timeout(60000)

    servers = await createMultipleServers(3)

    url = servers[0].url + '/inbox'

    await setKeysOfServer(servers[0], servers[1], keys.publicKey, null)
    await setKeysOfServer(servers[1], servers[1], keys.publicKey, keys.privateKey)

    const to = { url: 'http://localhost:' + servers[0].port + '/accounts/peertube' }
    const by = { url: 'http://localhost:' + servers[1].port + '/accounts/peertube', privateKey: keys.privateKey }
    await makeFollowRequest(to, by)
  })

  describe('When checking HTTP signature', function () {

    it('Should fail with an invalid digest', async function () {
      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = {
        Digest: buildDigest({ hello: 'coucou' })
      }

      try {
        await makePOSTAPRequest(url, body, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })

    it('Should fail with an invalid date', async function () {
      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)
      headers['date'] = 'Wed, 21 Oct 2015 07:28:00 GMT'

      try {
        await makePOSTAPRequest(url, body, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })

    it('Should fail with bad keys', async function () {
      await setKeysOfServer(servers[0], servers[1], invalidKeys.publicKey, invalidKeys.privateKey)
      await setKeysOfServer(servers[1], servers[1], invalidKeys.publicKey, invalidKeys.privateKey)

      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)

      try {
        await makePOSTAPRequest(url, body, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })

    it('Should reject requests without appropriate signed headers', async function () {
      await setKeysOfServer(servers[0], servers[1], keys.publicKey, keys.privateKey)
      await setKeysOfServer(servers[1], servers[1], keys.publicKey, keys.privateKey)

      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)

      const signatureOptions = baseHttpSignature()
      const badHeadersMatrix = [
        [ '(request-target)', 'date', 'digest' ],
        [ 'host', 'date', 'digest' ],
        [ '(request-target)', 'host', 'digest' ]
      ]

      for (const badHeaders of badHeadersMatrix) {
        signatureOptions.headers = badHeaders

        try {
          await makePOSTAPRequest(url, body, signatureOptions, headers)
          expect(true, 'Did not throw').to.be.false
        } catch (err) {
          expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
        }
      }
    })

    it('Should succeed with a valid HTTP signature draft 11 (without date but with (created))', async function () {
      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)

      const signatureOptions = baseHttpSignature()
      signatureOptions.headers = [ '(request-target)', '(created)', 'host', 'digest' ]

      const { statusCode } = await makePOSTAPRequest(url, body, signatureOptions, headers)
      expect(statusCode).to.equal(HttpStatusCode.NO_CONTENT_204)
    })

    it('Should succeed with a valid HTTP signature', async function () {
      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)

      const { statusCode } = await makePOSTAPRequest(url, body, baseHttpSignature(), headers)
      expect(statusCode).to.equal(HttpStatusCode.NO_CONTENT_204)
    })

    it('Should refresh the actor keys', async function () {
      this.timeout(20000)

      // Update keys of server 2 to invalid keys
      // Server 1 should refresh the actor and fail
      await setKeysOfServer(servers[1], servers[1], invalidKeys.publicKey, invalidKeys.privateKey)
      await setUpdatedAtOfServer(servers[0], servers[1], '2015-07-17 22:00:00+00')

      // Invalid peertube actor cache
      await killallServers([ servers[1] ])
      await servers[1].run()

      const body = activityPubContextify(getAnnounceWithoutContext(servers[1]), 'Announce')
      const headers = buildGlobalHeaders(body)

      try {
        await makePOSTAPRequest(url, body, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        console.error(err)
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })
  })

  describe('When checking Linked Data Signature', function () {
    before(async function () {
      this.timeout(10000)

      await setKeysOfServer(servers[0], servers[1], keys.publicKey, keys.privateKey)
      await setKeysOfServer(servers[1], servers[1], keys.publicKey, keys.privateKey)
      await setKeysOfServer(servers[2], servers[2], keys.publicKey, keys.privateKey)

      const to = { url: 'http://localhost:' + servers[0].port + '/accounts/peertube' }
      const by = { url: 'http://localhost:' + servers[2].port + '/accounts/peertube', privateKey: keys.privateKey }
      await makeFollowRequest(to, by)
    })

    it('Should fail with bad keys', async function () {
      this.timeout(10000)

      await setKeysOfServer(servers[0], servers[2], invalidKeys.publicKey, invalidKeys.privateKey)
      await setKeysOfServer(servers[2], servers[2], invalidKeys.publicKey, invalidKeys.privateKey)

      const body = getAnnounceWithoutContext(servers[1])
      body.actor = 'http://localhost:' + servers[2].port + '/accounts/peertube'

      const signer: any = { privateKey: invalidKeys.privateKey, url: 'http://localhost:' + servers[2].port + '/accounts/peertube' }
      const signedBody = await signAndContextify(signer, body, 'Announce')

      const headers = buildGlobalHeaders(signedBody)

      try {
        await makePOSTAPRequest(url, signedBody, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })

    it('Should fail with an altered body', async function () {
      this.timeout(10000)

      await setKeysOfServer(servers[0], servers[2], keys.publicKey, keys.privateKey)
      await setKeysOfServer(servers[0], servers[2], keys.publicKey, keys.privateKey)

      const body = getAnnounceWithoutContext(servers[1])
      body.actor = 'http://localhost:' + servers[2].port + '/accounts/peertube'

      const signer: any = { privateKey: keys.privateKey, url: 'http://localhost:' + servers[2].port + '/accounts/peertube' }
      const signedBody = await signAndContextify(signer, body, 'Announce')

      signedBody.actor = 'http://localhost:' + servers[2].port + '/account/peertube'

      const headers = buildGlobalHeaders(signedBody)

      try {
        await makePOSTAPRequest(url, signedBody, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })

    it('Should succeed with a valid signature', async function () {
      this.timeout(10000)

      const body = getAnnounceWithoutContext(servers[1])
      body.actor = 'http://localhost:' + servers[2].port + '/accounts/peertube'

      const signer: any = { privateKey: keys.privateKey, url: 'http://localhost:' + servers[2].port + '/accounts/peertube' }
      const signedBody = await signAndContextify(signer, body, 'Announce')

      const headers = buildGlobalHeaders(signedBody)

      const { statusCode } = await makePOSTAPRequest(url, signedBody, baseHttpSignature(), headers)
      expect(statusCode).to.equal(HttpStatusCode.NO_CONTENT_204)
    })

    it('Should refresh the actor keys', async function () {
      this.timeout(20000)

      // Wait refresh invalidation
      await wait(10000)

      // Update keys of server 3 to invalid keys
      // Server 1 should refresh the actor and fail
      await setKeysOfServer(servers[2], servers[2], invalidKeys.publicKey, invalidKeys.privateKey)

      const body = getAnnounceWithoutContext(servers[1])
      body.actor = 'http://localhost:' + servers[2].port + '/accounts/peertube'

      const signer: any = { privateKey: keys.privateKey, url: 'http://localhost:' + servers[2].port + '/accounts/peertube' }
      const signedBody = await signAndContextify(signer, body, 'Announce')

      const headers = buildGlobalHeaders(signedBody)

      try {
        await makePOSTAPRequest(url, signedBody, baseHttpSignature(), headers)
        expect(true, 'Did not throw').to.be.false
      } catch (err) {
        expect(err.statusCode).to.equal(HttpStatusCode.FORBIDDEN_403)
      }
    })
  })

  after(async function () {
    this.timeout(10000)

    await cleanupTests(servers)
  })
})
