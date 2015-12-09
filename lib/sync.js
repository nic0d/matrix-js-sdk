"use strict";

/*
 * TODO:
 * This class mainly serves to take all the syncing logic out of client.js and
 * into a separate file. It's all very fluid, and this class gut wrenches a lot
 * of MatrixClient props (e.g. _http). Given we want to support WebSockets as
 * an alternative syncing API, we may want to have a proper syncing interface
 * for HTTP and WS at some point.
 */
var q = require("q");
var StubStore = require("./store/stub");
var User = require("./models/user");
var Room = require("./models/room");
var utils = require("./utils");
var MatrixEvent = require("./models/event").MatrixEvent;

function retryTimeMsForAttempt(attempt) {
    // 2,4,8,16,32,64,128,128,128,... seconds
    // max 2^7 secs = 2.1 mins
    return Math.pow(2, Math.min(attempt, 7)) * 1000;
}

function startSyncingRetryTimer(client, attempt, fn) {
    client._syncingRetry = {};
    client._syncingRetry.fn = fn;
    client._syncingRetry.timeoutId = setTimeout(function() {
        fn();
    }, retryTimeMsForAttempt(attempt));
}

function updateSyncState(client, newState, data) {
    var old = client._syncState;
    client._syncState = newState;
    client.emit("sync", client._syncState, old, data);
}

function createNewUser(client, userId) {
    var user = new User(userId);
    reEmit(client, user, ["User.avatarUrl", "User.displayName", "User.presence"]);
    return user;
}

function createNewRoom(client, roomId) {
    var room = new Room(roomId, {
        pendingEventOrdering: client._config.pendingEventOrdering
    });
    reEmit(client, room, ["Room.name", "Room.timeline", "Room.receipt", "Room.tags"]);

    // we need to also re-emit room state and room member events, so hook it up
    // to the client now. We need to add a listener for RoomState.members in
    // order to hook them correctly. (TODO: find a better way?)
    reEmit(client, room.currentState, [
        "RoomState.events", "RoomState.members", "RoomState.newMember"
    ]);
    room.currentState.on("RoomState.newMember", function(event, state, member) {
        member.user = client.getUser(member.userId);
        reEmit(
            client, member,
            [
                "RoomMember.name", "RoomMember.typing", "RoomMember.powerLevel",
                "RoomMember.membership"
            ]
        );
    });
    return room;
}

function reEmit(reEmitEntity, emittableEntity, eventNames) {
    utils.forEach(eventNames, function(eventName) {
        // setup a listener on the entity (the Room, User, etc) for this event
        emittableEntity.on(eventName, function() {
            // take the args from the listener and reuse them, adding the
            // event name to the arg list so it works with .emit()
            // Transformation Example:
            // listener on "foo" => function(a,b) { ... }
            // Re-emit on "thing" => thing.emit("foo", a, b)
            var newArgs = [eventName];
            for (var i = 0; i < arguments.length; i++) {
                newArgs.push(arguments[i]);
            }
            reEmitEntity.emit.apply(reEmitEntity, newArgs);
        });
    });
}

function _syncRoom(client, room) {
    if (client._syncingRooms[room.roomId]) {
        return client._syncingRooms[room.roomId];
    }
    var defer = q.defer();
    client._syncingRooms[room.roomId] = defer.promise;
    client.roomInitialSync(room.roomId, client._config.initialSyncLimit).done(
    function(res) {
        room.timeline = []; // blow away any previous messages.
        _processRoomEvents(client, room, res.state, res.messages);
        room.recalculate(client.credentials.userId);
        client.store.storeRoom(room);
        client.emit("Room", room);
        defer.resolve(room);
        client._syncingRooms[room.roomId] = undefined;
    }, function(err) {
        defer.reject(err);
        client._syncingRooms[room.roomId] = undefined;
    });
    return defer.promise;
}

function _processRoomEvents(client, room, stateEventList, messageChunk) {
    // "old" and "current" state are the same initially; they
    // start diverging if the user paginates.
    // We must deep copy otherwise membership changes in old state
    // will leak through to current state!
    var oldStateEvents = utils.map(
        utils.deepCopy(stateEventList), client.getEventMapper()
    );
    var stateEvents = utils.map(stateEventList, client.getEventMapper());
    room.oldState.setStateEvents(oldStateEvents);
    room.currentState.setStateEvents(stateEvents);

    _resolveInvites(client, room);

    // add events to the timeline *after* setting the state
    // events so messages use the right display names. Initial sync
    // returns messages in chronological order, so we need to reverse
    // it to get most recent -> oldest. We need it in that order in
    // order to diverge old/current state correctly.
    room.addEventsToTimeline(
        utils.map(
            messageChunk ? messageChunk.chunk : [],
            client.getEventMapper()
        ).reverse(), true
    );
    if (messageChunk) {
        room.oldState.paginationToken = messageChunk.start;
    }
}

function _resolveInvites(client, room) {
    if (!room || !client._config.resolveInvitesToProfiles) {
        return;
    }
    // For each invited room member we want to give them a displayname/avatar url
    // if they have one (the m.room.member invites don't contain this).
    room.getMembersWithMembership("invite").forEach(function(member) {
        if (member._requestedProfileInfo) {
            return;
        }
        member._requestedProfileInfo = true;
        // try to get a cached copy first.
        var user = client.getUser(member.userId);
        var promise;
        if (user) {
            promise = q({
                avatar_url: user.avatarUrl,
                displayname: user.displayName
            });
        }
        else {
            promise = client.getProfileInfo(member.userId);
        }
        promise.done(function(info) {
            // slightly naughty by doctoring the invite event but this means all
            // the code paths remain the same between invite/join display name stuff
            // which is a worthy trade-off for some minor pollution.
            var inviteEvent = member.events.member;
            if (inviteEvent.getContent().membership !== "invite") {
                // between resolving and now they have since joined, so don't clobber
                return;
            }
            inviteEvent.getContent().avatar_url = info.avatar_url;
            inviteEvent.getContent().displayname = info.displayname;
            member.setMembershipEvent(inviteEvent, room.currentState); // fire listeners
        }, function(err) {
            // OH WELL.
        });
    });
}

/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @param {MatrixClient} client The matrix client instance to use.
 */
function SyncApi(client) {
    this.client = client;
    this.opts = {};
}

SyncApi.prototype.createRoom = function(roomId) {
    return createNewRoom(this.client, roomId);
};

SyncApi.prototype.syncRoom = function(room) {
    return _syncRoom(this.client, room);
};

/**
 * @param {Object} opts
 * @param {Number} opts.historyLen
 * @param {Boolean} opts.includeArchived
 */
SyncApi.prototype.sync = function(opts) {
    console.log("SyncApi.sync");
    this.opts = opts || {};
    return this._prepareForSync();
}


SyncApi.prototype._prepareForSync = function(attempt) {
    var client = this.client;
    var self = this;
    if (client.isGuest()) {
        // no push rules for guests
        this._sync();
        return;
    }

    attempt = attempt || 1;
    // we do push rules before syncing so when we gets events down we know immediately
    // whether they are bing-worthy.
    client.pushRules().done(function(result) {
        client.pushRules = result;
        self._sync();
    }, function(err) {
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            self._prepareForSync(attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
}

SyncApi.prototype._sync = function(attempt) {
    var opts = this.opts;
    var client = this.client;
    var self = this;
    var historyLen = opts.historyLen;
    var includeArchived = opts.includeArchived;
    attempt = attempt || 1;

    var qps = { limit: historyLen };
    if (includeArchived) {
        qps.archived = true;
    }
    if (client._guestRooms && client._isGuest) {
        qps.room_id = JSON.stringify(client._guestRooms);
    }
    client._http.authedRequest(
        undefined, "GET", "/initialSync", qps
    ).done(function(data) {
        var i, j;
        // intercept the results and put them into our store
        if (!(client.store instanceof StubStore)) {
            utils.forEach(
                utils.map(data.presence, client.getEventMapper()),
            function(e) {
                var user = createNewUser(client, e.getContent().user_id);
                user.setPresenceEvent(e);
                client.store.storeUser(user);
            });

            // group receipts by room ID.
            var receiptsByRoom = {};
            data.receipts = data.receipts || [];
            utils.forEach(data.receipts.map(client.getEventMapper()),
                function(receiptEvent) {
                    if (!receiptsByRoom[receiptEvent.getRoomId()]) {
                        receiptsByRoom[receiptEvent.getRoomId()] = [];
                    }
                    receiptsByRoom[receiptEvent.getRoomId()].push(receiptEvent);
                }
            );

            for (i = 0; i < data.rooms.length; i++) {
                var room = createNewRoom(client, data.rooms[i].room_id);
                if (!data.rooms[i].state) {
                    data.rooms[i].state = [];
                }
                if (data.rooms[i].membership === "invite") {
                    var inviteEvent = data.rooms[i].invite;
                    if (!inviteEvent) {
                        // fallback for servers which don't serve the invite key yet
                        inviteEvent = {
                            event_id: "$fake_" + room.roomId,
                            content: {
                                membership: "invite"
                            },
                            state_key: client.credentials.userId,
                            user_id: data.rooms[i].inviter,
                            room_id: room.roomId,
                            type: "m.room.member"
                        };
                    }
                    data.rooms[i].state.push(inviteEvent);
                }

                _processRoomEvents(
                    client, room, data.rooms[i].state, data.rooms[i].messages
                );

                var receipts = receiptsByRoom[room.roomId] || [];
                for (j = 0; j < receipts.length; j++) {
                    room.addReceipt(receipts[j]);
                }

                var privateUserData = data.rooms[i].account_data || [];
                var privateUserDataEvents =
                    utils.map(privateUserData, client.getEventMapper());
                for (j = 0; j < privateUserDataEvents.length; j++) {
                    var event = privateUserDataEvents[j];
                    if (event.getType() === "m.tag") {
                        room.addTags(event);
                    }
                    // XXX: unhandled private user data event - we should probably
                    // put it somewhere useful once the API has settled
                }

                // cache the name/summary/etc prior to storage since we don't
                // know how the store will serialise the Room.
                room.recalculate(client.credentials.userId);

                client.store.storeRoom(room);
                client.emit("Room", room);
            }
        }

        if (data) {
            client.store.setSyncToken(data.end);
            var events = [];
            for (i = 0; i < data.presence.length; i++) {
                events.push(new MatrixEvent(data.presence[i]));
            }
            for (i = 0; i < data.rooms.length; i++) {
                if (data.rooms[i].state) {
                    for (j = 0; j < data.rooms[i].state.length; j++) {
                        events.push(new MatrixEvent(data.rooms[i].state[j]));
                    }
                }
                if (data.rooms[i].messages) {
                    for (j = 0; j < data.rooms[i].messages.chunk.length; j++) {
                        events.push(
                            new MatrixEvent(data.rooms[i].messages.chunk[j])
                        );
                    }
                }
            }
            utils.forEach(events, function(e) {
                client.emit("event", e);
            });
        }

        client.clientRunning = true;
        updateSyncState(client, "PREPARED");
        // assume success until we fail which may be 30+ secs
        updateSyncState(client, "SYNCING");
        self._pollForEvents();
    }, function(err) {
        console.error("/initialSync error (%s attempts): %s", attempt, err);
        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            self._sync(attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
};

/**
 * This is an internal method.
 * @param {MatrixClient} client
 * @param {Number} attempt The attempt number
 */
SyncApi.prototype._pollForEvents = function(attempt) {
    var client = this.client;
    var self = this;

    attempt = attempt || 1;
    
    if (!client.clientRunning) {
        return;
    }
    var timeoutMs = client._config.pollTimeout;
    if (attempt > 1) {
        // we think the connection is dead. If it comes back up, we won't know
        // about it till /events returns. If the timeout= is high, this could
        // be a long time. Set it to 1 when doing retries.
        timeoutMs = 1;
    }
    var discardResult = false;
    var timeoutObj = setTimeout(function() {
        discardResult = true;
        console.error("/events request timed out.");
        self._pollForEvents();
    }, timeoutMs + (20 * 1000)); // 20s buffer

    var queryParams = {
        from: client.store.getSyncToken(),
        timeout: timeoutMs
    };
    if (client._guestRooms && client._isGuest) {
        queryParams.room_id = client._guestRooms;
    }

    client._http.authedRequest(undefined, "GET", "/events", queryParams).done(
    function(data) {
        if (discardResult) {
            return;
        }
        else {
            clearTimeout(timeoutObj);
        }

        if (client._syncState !== "SYNCING") {
            updateSyncState(client, "SYNCING");
        }

        try {
            var events = [];
            if (data) {
                events = utils.map(data.chunk, client.getEventMapper());
            }
            if (!(client.store instanceof StubStore)) {
                var roomIdsWithNewInvites = {};
                // bucket events based on room.
                var i = 0;
                var roomIdToEvents = {};
                for (i = 0; i < events.length; i++) {
                    var roomId = events[i].getRoomId();
                    // possible to have no room ID e.g. for presence events.
                    if (roomId) {
                        if (!roomIdToEvents[roomId]) {
                            roomIdToEvents[roomId] = [];
                        }
                        roomIdToEvents[roomId].push(events[i]);
                        if (events[i].getType() === "m.room.member" &&
                                events[i].getContent().membership === "invite") {
                            roomIdsWithNewInvites[roomId] = true;
                        }
                    }
                    else if (events[i].getType() === "m.presence") {
                        var usr = client.store.getUser(events[i].getContent().user_id);
                        if (usr) {
                            usr.setPresenceEvent(events[i]);
                        }
                        else {
                            usr = createNewUser(client, events[i].getContent().user_id);
                            usr.setPresenceEvent(events[i]);
                            client.store.storeUser(usr);
                        }
                    }
                }

                // add events to room
                var roomIds = utils.keys(roomIdToEvents);
                utils.forEach(roomIds, function(roomId) {
                    var room = client.store.getRoom(roomId);
                    var isBrandNewRoom = false;
                    if (!room) {
                        room = createNewRoom(client, roomId);
                        isBrandNewRoom = true;
                    }

                    var wasJoined = room.hasMembershipState(
                        client.credentials.userId, "join"
                    );

                    room.addEvents(roomIdToEvents[roomId], "replace");
                    room.recalculate(client.credentials.userId);

                    // store the Room for things like invite events so developers
                    // can update the UI
                    if (isBrandNewRoom) {
                        client.store.storeRoom(room);
                        client.emit("Room", room);
                    }

                    var justJoined = room.hasMembershipState(
                        client.credentials.userId, "join"
                    );

                    if (!wasJoined && justJoined) {
                        // we've just transitioned into a join state for this room,
                        // so sync state.
                        _syncRoom(client, room);
                    }
                });

                Object.keys(roomIdsWithNewInvites).forEach(function(inviteRoomId) {
                    _resolveInvites(client, client.store.getRoom(inviteRoomId));
                });
            }
            if (data) {
                client.store.setSyncToken(data.end);
                utils.forEach(events, function(e) {
                    client.emit("event", e);
                });
            }
        }
        catch (e) {
            console.error("Event stream error:");
            console.error(e);
        }
        self._pollForEvents();
    }, function(err) {
        console.error("/events error: %s", JSON.stringify(err));
        if (discardResult) {
            return;
        }
        else {
            clearTimeout(timeoutObj);
        }

        attempt += 1;
        startSyncingRetryTimer(client, attempt, function() {
            self._pollForEvents(attempt);
        });
        updateSyncState(client, "ERROR", { error: err });
    });
}

module.exports = SyncApi;