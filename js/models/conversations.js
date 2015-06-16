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
(function () {
  'use strict';
   window.Whisper = window.Whisper || {};

   // TODO: Factor out private and group subclasses of Conversation

  Whisper.Conversation = Backbone.Model.extend({
    database: Whisper.Database,
    storeName: 'conversations',
    defaults: function() {
      var timestamp = new Date().getTime();
      return {
        unreadCount : 0,
        timestamp   : timestamp,
        active_at   : timestamp
      };
    },

    initialize: function() {
        this.contactCollection = new Whisper.ConversationCollection();
        this.messageCollection = new Whisper.MessageCollection([], {
            conversation: this
        });

        this.on('change:avatar', this.updateAvatarUrl);
        this.on('destroy', this.revokeAvatarUrl);
    },

    validate: function(attributes, options) {
        var required = ['id', 'type'];
        var missing = _.filter(required, function(attr) { return !attributes[attr]; });
        if (missing.length) { return "Conversation must have " + missing; }

        if (attributes.type !== 'private' && attributes.type !== 'group') {
            return "Invalid conversation type: " + attributes.type;
        }

        // hack
        if (this.get('type') === 'private') {
            try {
                this.id = libphonenumber.util.verifyNumber(this.id);
                var number = libphonenumber.util.splitCountryCode(this.id);

                this.set({
                    e164_number: this.id,
                    national_number: '' + number.national_number,
                    international_number: '' + number.country_code + number.national_number
                });
            } catch(ex) {
                return ex;
            }
        }
    },

    sendMessage: function(body, attachments) {
        var now = Date.now();
        var message = this.messageCollection.add({
            body           : body,
            conversationId : this.id,
            type           : 'outgoing',
            attachments    : attachments,
            sent_at        : now,
            received_at    : now,
            pending        : true
        });
        message.save();

        this.save({
            unreadCount : 0,
            active_at   : now,
            timestamp   : now,
            lastMessage : body
        }).then(function() {
            extension.trigger('updateInbox'); // inbox fetch
        });

        var sendFunc;
        if (this.get('type') == 'private') {
            sendFunc = textsecure.messaging.sendMessageToNumber;
        }
        else {
            sendFunc = textsecure.messaging.sendMessageToGroup;
        }
        sendFunc(this.get('id'), body, attachments, now).then(function() {
            message.unset('pending');
            message.save();
        }.bind(this)).catch(function(errors) {
            if (errors instanceof Error) {
                errors = [errors];
            }
            var keyErrors = [];
            _.each(errors, function(e) {
                if (e.error.name === 'OutgoingIdentityKeyError') {
                    keyErrors.push(e.error);
                }
            });
            if (keyErrors.length) {
                message.save({ errors : keyErrors }).then(function() {
                    extension.trigger('updateInbox'); // notify frontend listeners
                });
            } else {
                if (!(errors instanceof Array)) {
                    errors = [errors];
                }
                errors.map(function(e) {
                    if (e.error && e.error.stack) {
                        console.error(e.error.stack);
                    }
                });
                throw errors;
            }
        });
    },

    endSession: function() {
        if (this.get('type') === 'private') {
            var now = Date.now();
            textsecure.messaging.closeSession(this.id);
            this.messageCollection.add({
                conversationId : this.id,
                type           : 'outgoing',
                sent_at        : now,
                received_at    : now,
                flags          : textsecure.protobuf.Message.Flags.END_SESSION
            }).save();
        }

    },

    leaveGroup: function() {
        var now = Date.now();
        if (this.get('type') === 'group') {
            textsecure.messaging.leaveGroup(this.id);
            this.messageCollection.add({
                group_update: { left: 'You' },
                conversationId : this.id,
                type           : 'outgoing',
                sent_at        : now,
                received_at    : now
            }).save();
        }
    },

    markRead: function() {
        if (this.get('unreadCount') > 0) {
            this.save({unreadCount: 0});
        }
    },

    fetchMessages: function(options) {
        return this.messageCollection.fetchConversation(this.id, options);
    },

    fetchContacts: function(options) {
        if (this.isPrivate()) {
            this.contactCollection.reset([this]);
        } else {
            var members = this.get('members') || [];
            this.contactCollection.reset(
                members.map(function(number) {
                    var c = this.collection.add({id: number, type: 'private'});
                    c.fetch();
                    return c;
                }.bind(this))
            );
        }
    },

    archive: function() {
        this.unset('active_at');
    },

    destroyMessages: function() {
        var models = this.messageCollection.models;
        this.messageCollection.reset([]);
        _.each(models, function(message) { message.destroy(); });
        this.archive();
        return this.save().then(function() {
            extension.trigger('updateInbox');
        });
    },

    getTitle: function() {
        if (this.isPrivate()) {
            return this.get('name') || this.id;
        } else {
            return this.get('name') || 'Unknown group';
        }
    },

    getNumber: function() {
        if (this.get('type') === 'private') {
            return this.id;
        } else {
            return '';
        }
    },

    isPrivate: function() {
        return this.get('type') === 'private';
    },

    revokeAvatarUrl: function() {
        if (this.avatarUrl) {
            URL.revokeObjectURL(this.avatarUrl);
            this.avatarUrl = null;
        }
    },

    updateAvatarUrl: function(silent) {
        this.revokeAvatarUrl();
        var avatar = this.get('avatar');
        if (avatar) {
            this.avatarUrl = URL.createObjectURL(
                new Blob([avatar.data], {type: avatar.contentType})
            );
        } else {
            this.avatarUrl = null;
        }
        if (!silent) {
            this.trigger('change');
        }
    },

    getAvatarUrl: function() {
        if (this.avatarUrl === undefined) {
            this.updateAvatarUrl(true);
        }
        return this.avatarUrl || '/images/default.png';
    },

    resolveConflicts: function(number) {
        if (this.isPrivate()) {
            number = this.id;
        } else if (!_.include(this.get('members'), number)) {
            throw 'Tried to resolve conflicts for a unknown group member';
        }

        if (!this.messageCollection.hasKeyConflicts()) {
            throw 'No conflicts to resolve';
        }

        return textsecure.storage.axolotl.removeIdentityKey(number).then(function() {
            this.messageCollection.each(function(message) {
                if (message.hasKeyConflict(number)) {
                    message.resolveConflict(number);
                }
            });
        }.bind(this));
    }
  });

  Whisper.ConversationCollection = Backbone.Collection.extend({
    database: Whisper.Database,
    storeName: 'conversations',
    model: Whisper.Conversation,

    comparator: function(m) {
      return -m.get('timestamp');
    },

    destroyAll: function () {
        return Promise.all(this.models.map(function(m) {
            return new Promise(function(resolve, reject) {
                m.destroy().then(resolve).fail(reject);
            });
        }));
    },

    fetchGroups: function(number) {
        return this.fetch({
            index: {
                name: 'group',
                only: number
            }
        });
    },

    fetchActive: function() {
        // Ensures all active conversations are included in this collection,
        // and updates their attributes, but removes nothing.
        return this.fetch({
            index: {
                name: 'inbox', // 'inbox' index on active_at
                order: 'desc'  // ORDER timestamp DESC
                // TODO pagination/infinite scroll
                // limit: 10, offset: page*10,
            },
            remove: false
        });
    }
  });
})();
