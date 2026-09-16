const axios = require('axios')
const { globalApiKey, disabledCallbacks, enableWebHook } = require('./config')
const { logger } = require('./logger')
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory')
const Client = require('whatsapp-web.js').Client
const { Chat, Message } = require('whatsapp-web.js/src/structures')

// Trigger webhook endpoint
const triggerWebhook = (webhookURL, sessionId, dataType, data) => {
  if (enableWebHook) {
    axios.post(webhookURL, { dataType, data, sessionId }, { headers: { 'x-api-key': globalApiKey } })
      .then(() => logger.debug({ sessionId, dataType, data: data || '' }, `Webhook message sent to ${webhookURL}`))
      .catch(error => logger.error({ sessionId, dataType, err: error, data: data || '' }, `Failed to send webhook message to ${webhookURL}`))
  }
}

// Function to send a response with error status and message
const sendErrorResponse = (res, status, error) => {
  const message = error instanceof Error ? error.message : error
  if (error instanceof Error) {
    logger.error({ err: error }, message)
  }
  res.status(status).json({ success: false, error: message })
}

// Function to wait for a specific item not to be null
const waitForNestedObject = (rootObj, nestedPath, maxWaitTime = 10000, interval = 100) => {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const checkObject = () => {
      const nestedObj = nestedPath.split('.').reduce((obj, key) => obj ? obj[key] : undefined, rootObj)
      if (nestedObj) {
        // Nested object exists, resolve the promise
        resolve()
      } else if (Date.now() - start > maxWaitTime) {
        // Maximum wait time exceeded, reject the promise
        logger.error('Timed out waiting for nested object')
        reject(new Error('Timeout waiting for nested object'))
      } else {
        // Nested object not yet created, continue waiting
        setTimeout(checkObject, interval)
      }
    }
    checkObject()
  })
}

const isEventEnabled = (event) => {
  return !disabledCallbacks.includes(event)
}

const sendMessageSeenStatus = async (message) => {
  try {
    const chat = await message.getChat()
    await chat.sendSeen()
  } catch (error) {
    logger.error(error, 'Failed to send seen status')
  }
}

const decodeBase64 = function * (base64String) {
  const chunkSize = 1024
  for (let i = 0; i < base64String.length; i += chunkSize) {
    const chunk = base64String.slice(i, i + chunkSize)
    yield Buffer.from(chunk, 'base64')
  }
}

const sleep = function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const exposeFunctionIfAbsent = async (page, name, fn) => {
  const exist = await page.evaluate((name) => {
    return !!window[name]
  }, name)
  if (exist) {
    return
  }
  await page.exposeFunction(name, fn)
}

const patchWWebLibrary = async (client) => {
  // MUST be run after the 'ready' event fired
  Client.prototype.getChats = async function (searchOptions = {}) {
    const chats = await this.pupPage.evaluate(async (searchOptions) => {
      return await window.WWebJS.getChats({ ...searchOptions })
    }, searchOptions)

    return chats.map(chat => ChatFactory.create(this, chat))
  }

  Chat.prototype.fetchMessages = async function (searchOptions) {
    const messages = await this.client.pupPage.evaluate(async (chatId, searchOptions) => {
      const msgFilter = (m) => {
        if (m.isNotification) {
          return false
        }
        if (searchOptions && searchOptions.fromMe !== undefined && m.id.fromMe !== searchOptions.fromMe) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && m.t < searchOptions.since) {
          return false
        }
        if (searchOptions && searchOptions.messageId !== undefined && m.id.id !== searchOptions.messageId) {
          return false
        }
        return true
      }

      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
      let msgs = chat.msgs.getModelsArray().filter(msgFilter)

      if (searchOptions && searchOptions.limit > 0) {
        while (msgs.length < searchOptions.limit) {
          const loadedMessages = await (window.require('WAWebChatLoadMessages')).loadEarlierMsgs({ chat })

          if (!loadedMessages || !loadedMessages.length) break
          msgs = [...loadedMessages.filter(msgFilter), ...msgs]
        }

        if (msgs.length > searchOptions.limit) {
          msgs.sort((a, b) => (a.t > b.t) ? 1 : -1)
          msgs = msgs.splice(msgs.length - searchOptions.limit)
        }
      }

      // Same guard as getChats: one message that cannot be modelled must not
      // reject the entire fetch.
      return msgs.map(m => {
        try {
          return window.WWebJS.getMessageModel(m)
        } catch (error) {
          console.warn('getMessageModel failed, skipping message', m?.id?.id, error?.message)
          return null
        }
      }).filter(Boolean)
    }, this.id._serialized, searchOptions)

    return messages.map(m => new Message(this.client, m))
  }

  await client.pupPage.evaluate(() => {
    // WhatsApp Web renamed the serialized message-key property, so a key may
    // carry either `_serialized` or `$1`. Reading the old name alone yields
    // undefined, which reaches IndexedDB as a missing key and throws
    // "Failed to execute 'get' on 'IDBObjectStore'".
    const getMsgKeyId = (key) => key?._serialized ?? key?.$1 ?? null

    // Restore `_serialized` on the message-key class itself, so the many places
    // in whatsapp-web.js that read it keep working. Without this, sendMessage's
    // final `Msg.get(newMsgKey._serialized)` looks up undefined and returns no
    // message, leaving callers with a bare {"success":true} and no message id.
    try {
      const msgKeyModule = window.require('WAWebMsgKey')
      const MsgKey = msgKeyModule?.default ?? msgKeyModule
      const proto = MsgKey?.prototype
      if (proto && !('_serialized' in proto)) {
        Object.defineProperty(proto, '_serialized', {
          configurable: true,
          get () { return this.$1 }
        })
        console.warn('applied _serialized fallback to WAWebMsgKey')
      }
    } catch (error) {
      console.warn('could not patch WAWebMsgKey', error?.message)
    }

    // Message models are serialized plain objects, so the getter above does not
    // reach them. Mirror `$1` onto `_serialized` so API consumers keep seeing
    // the message id they have always received.
    const originalGetMessageModel = window.WWebJS.getMessageModel
    window.WWebJS.getMessageModel = (message) => {
      const msg = originalGetMessageModel(message)
      if (msg?.id && msg.id._serialized === undefined && msg.id.$1 !== undefined) {
        msg.id._serialized = msg.id.$1
      }
      return msg
    }

    // Reimplements window.WWebJS.getChatModel so that the parts which break on
    // LID-addressed chats degrade instead of rejecting. Upstream lets any of
    // them fail the whole model, which surfaced as {"success":false,"error":"r"}
    // from every chat endpoint. Keep in sync with whatsapp-web.js
    // src/util/Injected/Utils.js. See avoylenko/wwebjs-api#147 and
    // wwebjs/whatsapp-web.js#201845.
    window.WWebJS.getChatModel = async (chat, { isChannel = false } = {}) => {
      if (!chat) return null

      const model = chat.serialize()
      model.isGroup = false
      model.isMuted = chat.mute?.expiration !== 0
      if (isChannel) {
        model.isChannel = window.require('WAWebChatGetters').getIsNewsletter(chat)
      } else {
        model.formattedTitle = chat.formattedTitle
      }

      if (chat.groupMetadata) {
        model.isGroup = true
        try {
          const chatWid = window.require('WAWebWidFactory').createWid(chat.id._serialized)
          const collections = window.require('WAWebCollections')
          const groupMetadata = collections.GroupMetadata || collections.WAWebGroupMetadataCollection
          await groupMetadata.update(chatWid)
        } catch (error) {
          // Only refreshes the cached metadata serialized just below.
          console.warn('groupMetadata.update failed for', chat.id?._serialized, error?.message)
        }
        let toPn = null
        try {
          toPn = window.require('WAWebLidMigrationUtils').toPn
        } catch (error) {
          toPn = null
        }
        const serializedMetadata = chat.groupMetadata.serialize()
        for (const p of serializedMetadata.participants || []) {
          try {
            p.id = (toPn ? toPn(p.id) : null) ?? p.id
          } catch (error) {
            // No phone mapping for this participant, keep the LID id.
          }
        }
        model.groupMetadata = serializedMetadata
        model.isReadOnly = chat.groupMetadata.announce
      }

      if (chat.newsletterMetadata) {
        try {
          const collections = window.require('WAWebCollections')
          const newsletterMetadata = collections.NewsletterMetadataCollection || collections.WAWebNewsletterMetadataCollection
          await newsletterMetadata.update(chat.id)
          model.channelMetadata = chat.newsletterMetadata.serialize()
          model.channelMetadata.createdAtTs = chat.newsletterMetadata.creationTime
        } catch (error) {
          console.warn('newsletterMetadata.update failed for', chat.id?._serialized, error?.message)
        }
      }

      model.lastMessage = null
      const lastKeyId = getMsgKeyId(chat.lastReceivedKey)
      if (model.msgs && model.msgs.length && lastKeyId) {
        try {
          const Msg = window.require('WAWebCollections').Msg
          const lastMessage = Msg.get(lastKeyId) || (await Msg.getMessagesById([lastKeyId]))?.messages?.[0]
          if (lastMessage) {
            model.lastMessage = window.WWebJS.getMessageModel(lastMessage)
          }
        } catch (error) {
          console.warn('lastMessage lookup failed for', chat.id?._serialized, error?.message)
        }
      }

      // Live collections that puppeteer cannot serialize.
      delete model.msgs
      delete model.msgUnsyncedButtonReplyMsgs
      delete model.unsyncedButtonReplies

      return model
    }

    // hotfix for https://github.com/pedroslopez/whatsapp-web.js/pull/3643
    window.WWebJS.getChats = async (searchOptions = {}) => {
      const chatFilter = (c) => {
        if (searchOptions && searchOptions.unread === true && c.unreadCount === 0) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && c.t < searchOptions.since) {
          return false
        }
        return true
      }

      const allChats = window.require('WAWebCollections').Chat.getModelsArray()

      const filteredChats = allChats.filter(chatFilter)

      // Last resort: a chat that still cannot be modelled is skipped rather than
      // rejecting the whole listing.
      const chats = await Promise.all(
        filteredChats.map(async (chat) => {
          try {
            return await window.WWebJS.getChatModel(chat)
          } catch (error) {
            console.warn('skipping chat', chat?.id?._serialized, error?.message)
            return null
          }
        })
      )

      return chats.filter(Boolean)
    }
  })
}

module.exports = {
  triggerWebhook,
  sendErrorResponse,
  waitForNestedObject,
  isEventEnabled,
  sendMessageSeenStatus,
  decodeBase64,
  sleep,
  exposeFunctionIfAbsent,
  patchWWebLibrary
}
