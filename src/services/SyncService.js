/* eslint-disable jsdoc/valid-types */
/**
 * @copyright Copyright (c) 2019 Julius Härtl <jus@bitgrid.net>
 *
 * @author Julius Härtl <jus@bitgrid.net>
 *
 * @license AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 */
import mitt from 'mitt'

import PollingBackend from './PollingBackend.js'
import SessionApi, { Connection } from './SessionApi.js'
import { logger } from '../helpers/logger.js'

/**
 * Timeout after which the editor will consider a document without changes being synced as idle
 * The session will be terminated and the document will stay open in read-only mode with a button to reconnect if needed
 *
 * @type {number}
 */
const IDLE_TIMEOUT = 1440

const ERROR_TYPE = {
	/**
	 * Failed to save collaborative document due to external change
	 * collission needs to be resolved manually
	 */
	SAVE_COLLISSION: 0,
	/**
	 * Failed to push changes for MAX_REBASE_RETRY times
	 */
	PUSH_FAILURE: 1,

	LOAD_ERROR: 2,

	CONNECTION_FAILED: 3,

	SOURCE_NOT_FOUND: 4,
}

class SyncService {

	constructor({ serialize, getDocumentState, ...options }) {
		/** @type {import('mitt').Emitter<import('./SyncService').EventTypes>} _bus */
		this._bus = mitt()

		this.serialize = serialize
		this.getDocumentState = getDocumentState
		this._api = new SessionApi(options)
		this.connection = null

		this.sessions = []

		this.steps = []
		this.stepClientIDs = []

		this.lastStepPush = Date.now()

		this.version = null
		this.sending = false

		return this
	}

	async open({ fileId, initialSession }) {
		this.on('change', ({ sessions }) => {
			this.sessions = sessions
		})

		// TODO: Only continue if a connection was made
		this.connection = initialSession
			? new Connection({ data: initialSession }, {})
			: await this._api.open({ fileId })
				.catch(error => this._emitError(error))

		this.version = this.connection.lastSavedVersion
		this.emit('opened', {
			...this.connection.state,
			version: this.version,
		})
		this.emit('loaded', {
			...this.connection.state,
			version: this.version,
		})
		this.backend = new PollingBackend(this, this.connection)

	}

	startSync() {
		this.backend.connect()
	}

	_emitError(error) {
		if (!error.response || error.code === 'ECONNABORTED') {
			this.emit('error', { type: ERROR_TYPE.CONNECTION_FAILED, data: {} })
		} else {
			this.emit('error', { type: ERROR_TYPE.LOAD_ERROR, data: error.response })
		}
	}

	updateSession(guestName) {
		if (!this.connection.isPublic) {
			return
		}
		return this.connection.update(guestName)
			.catch((error) => {
				logger.error('Failed to update the session', { error })
				return Promise.reject(error)
			})
	}

	sendSteps(getSendable) {
		this.emit('stateChange', { dirty: true })
		if (!this.connection || this.sending) {
			setTimeout(() => {
				this.sendSteps(getSendable)
			}, 200)
			return
		}
		this.sending = true
		return this.connection.push(getSendable())
			.then((response) => {
				this.sending = false
			}).catch(({ response, code }) => {
				logger.error('failed to apply steps due to collission, retrying')
				this.sending = false
				if (!response || code === 'ECONNABORTED') {
					this.emit('error', { type: ERROR_TYPE.CONNECTION_FAILED, data: {} })
					return
				}
				const { status, data } = response
				if (status === 403) {
					if (!data.document) {
						// either the session is invalid or the document is read only.
						logger.error('failed to write to document - not allowed')
					}
					// Only emit conflict event if we have synced until the latest version
					if (data.document?.currentVersion === this.version) {
						this.emit('error', { type: ERROR_TYPE.PUSH_FAILURE, data: {} })
						OC.Notification.showTemporary('Changes could not be sent yet')
					}
				}
				// TODO: Retry and warn
			})
	}

	stepsSince(version) {
		return {
			steps: this.steps.slice(version),
			clientIDs: this.stepClientIDs.slice(version),
		}
	}

	_receiveSteps({ steps, document }) {
		const newSteps = []
		for (let i = 0; i < steps.length; i++) {
			const singleSteps = steps[i].data
			if (this.version < steps[i].version) {
				this.version = steps[i].version
			}
			if (!Array.isArray(singleSteps)) {
				logger.error('Invalid step data, skipping step', { step: steps[i] })
				// TODO: recover
				continue
			}
			singleSteps.forEach(step => {
				this.steps.push(step)
				newSteps.push({
					step,
					clientID: steps[i].sessionId,
				})
			})
		}
		this.lastStepPush = Date.now()
		this.emit('sync', {
			steps: newSteps,
			// TODO: do we actually need to dig into the connection here?
			document: this.connection.document,
			version: this.version,
		})
	}

	checkIdle() {
		const lastPushMinutesAgo = (Date.now() - this.lastStepPush) / 1000 / 60
		if (lastPushMinutesAgo > IDLE_TIMEOUT) {
			logger.debug(`[SyncService] Document is idle for ${this.IDLE_TIMEOUT} minutes, suspending connection`)
			this.emit('idle')
			return true
		}
		return false
	}

	_getContent() {
		return this.serialize()
	}

	save() {
		this?.backend?.save?.()
	}

	forceSave() {
		this.backend.connect()
		if (this.backend.forceSave) {
			this.backend.forceSave()
		}
	}

	close() {
		this.backend.disconnect()
		let closed = false
		return new Promise((resolve, reject) => {
			this.on('save', () => {
				this._close().then(() => {
					closed = true
					resolve()
				}).catch(() => resolve())
			})
			setTimeout(() => {
				if (!closed) {
					this._close().then(() => {
						resolve()
					}).catch(() => resolve())
				}
			}, 2000)
			this.save()
		})
	}

	_close() {
		if (this.connection === null) {
			return Promise.resolve()
		}
		this.backend.disconnect()
		return this.connection.close()
	}

	uploadAttachment(file) {
		return this.connection.uploadAttachment(file)
	}

	insertAttachmentFile(filePath) {
		return this.connection.insertAttachmentFile(filePath)
	}

	on(event, callback) {
		this._bus.on(event, callback)
		return this
	}

	off(event, callback) {
		this._bus.off(event, callback)
		return this
	}

	emit(event, data) {
		this._bus.emit(event, data)
	}

}

export default SyncService
export { SyncService, ERROR_TYPE, IDLE_TIMEOUT }
