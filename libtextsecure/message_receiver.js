/* vim: ts=4:sw=4:expandtab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

;(function () {
    'use strict';
    window.textsecure = window.textsecure || {};

    function MessageReceiver(eventTarget) {
        if (eventTarget instanceof EventTarget) {
            this.target = eventTarget;
        } else {
            throw new TypeError('MessageReceiver expected an EventTarget');
        }
    }

    MessageReceiver.prototype = {
        constructor: MessageReceiver,
        connect: function() {
            // initialize the socket and start listening for messages
            this.socket = TextSecureServer.getMessageWebsocket();

            new WebSocketResource(this.socket, this.handleRequest.bind(this));
        },
        handleRequest: function(request) {
            // TODO: handle different types of requests. for now we only expect
            // PUT /messages <encrypted IncomingPushMessageSignal>
            textsecure.crypto.decryptWebsocketMessage(request.body).then(function(plaintext) {
                var proto = textsecure.protobuf.Envelope.decode(plaintext);
                // After this point, decoding errors are not the server's
                // fault, and we should handle them gracefully and tell the
                // user they received an invalid message
                request.respond(200, 'OK');

                if (proto.type === textsecure.protobuf.Envelope.Type.RECEIPT) {
                    this.onDeliveryReceipt(proto);
                } else if (proto.synchronize) {
                    this.handleSyncMessage(proto);
                } else {
                    this.onMessageReceived(proto);
                }

            }.bind(this)).catch(function(e) {
                console.log("Error handling incoming message:", e);
                extension.trigger('error', e);
                request.respond(500, 'Bad encrypted websocket message');
            });
        },
        getStatus: function() {
            if (this.socket) {
                return this.socket.getStatus();
            } else {
                return -1;
            }
        },
        onDeliveryReceipt: function (envelope) {
            var ev = new Event('receipt');
            ev.proto = envelope;
            this.target.dispatchEvent(ev);
        },
        onMessageReceived: function(envelope) {
            var ev = new Event('message');
            ev.proto = envelope;
            this.target.dispatchEvent(ev);
        },
        handleSyncMessage: function (envelope) {
            return textsecure.protocol_wrapper.handleEncryptedMessage(
                envelope.source,
                envelope.sourceDevice,
                envelope.type,
                envelope.synchronize
            ).then(function(syncMessage) {
                if (syncMessage.message) {
                    this.onMessageReceived(envelope);
                } else if (syncMessage.contacts) {
                    this.onContactsReceived(syncMessage.contacts);
                } else if (syncMessage.group) {
                    this.onGroupReceived(syncMessage.group);
                }
            }.bind(this));
        },
        onContactsReceived: function(contacts) {
            var eventTarget = this.target;
            var attachmentPointer = contacts.blob;
            handleAttachment(attachmentPointer).then(function() {
                var contactBuffer = new ContactBuffer(attachmentPointer.data);
                var contactInfo = contactBuffer.readContact();
                while (contactInfo !== undefined) {
                    var ev = new Event('contact');
                    ev.contactInfo = contactInfo;
                    eventTarget.dispatchEvent(ev);
                    contactInfo = contactBuffer.readContact();
                }
            });
        },
        onGroupReceived: function(envelope) {
            var ev = new Event('group');
            ev.group = envelope.group;
            this.target.dispatchEvent(ev);
        }
    };

    textsecure.MessageReceiver = MessageReceiver;

}());
