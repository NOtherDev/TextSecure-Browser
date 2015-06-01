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
            var eventTarget = this.target;

            new WebSocketResource(this.socket, function(request) {
                // TODO: handle different types of requests. for now we only expect
                // PUT /messages <encrypted IncomingPushMessageSignal>
                textsecure.crypto.decryptWebsocketMessage(request.body).then(function(plaintext) {
                    var proto = textsecure.protobuf.Envelope.decode(plaintext);
                    // After this point, decoding errors are not the server's
                    // fault, and we should handle them gracefully and tell the
                    // user they received an invalid message
                    request.respond(200, 'OK');

                    if (proto.type === textsecure.protobuf.Envelope.Type.RECEIPT) {
                        onDeliveryReceipt(proto, eventTarget);
                    } else if (proto.synchronize) {
                        handleSyncMessage(proto, eventTarget);
                    } else {
                        onMessageReceived(proto, eventTarget);
                    }

                }).catch(function(e) {
                    console.log("Error handling incoming message:", e);
                    extension.trigger('error', e);
                    request.respond(500, 'Bad encrypted websocket message');
                });
            });
        },
        getStatus: function() {
            if (this.socket) {
                return this.socket.getStatus();
            } else {
                return -1;
            }
        }
    };

    function onDeliveryReceipt(envelope, eventTarget) {
        var ev = new Event('receipt');
        ev.proto = envelope;
        eventTarget.dispatchEvent(ev);
    }
    function onMessageReceived(envelope, eventTarget) {
        var ev = new Event('message');
        ev.proto = envelope;
        eventTarget.dispatchEvent(ev);
    }
    function onContactsReceived(attachmentPointer, eventTarget) {
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
    }
    function onGroupReceived(envelope, eventTarget) {
        var ev = new Event('group');
        ev.group = envelope.group;
        eventTarget.dispatchEvent(ev);
    }

    function handleSyncMessage(envelope, eventTarget) {
        return textsecure.protocol_wrapper.handleIncomingPushMessageProto(envelope).then(
            function(syncMessage) {
                if (syncMessage.message) {
                    onMessageReceived(proto);
                } else if (syncMessage.contacts) {
                    onContactsReceived(syncMessage.contacts.blob, eventTarget);
                } else if (syncMessage.group) {
                    onGroupReceived(syncMessage.group);
                }
            }
        );
    }

    textsecure.MessageReceiver = MessageReceiver;

}());
