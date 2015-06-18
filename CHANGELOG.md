Changes in 0.1.1
================

Breaking changes:
 * `Room.calculateRoomName` is now private. Use `Room.recalculate` instead, and
   access the calculated name via `Room.name`.
 * `new MatrixClient(...)` no longer creates a `MatrixInMemoryStore` if
   `opts.store` is not specified. Instead, the `createClient` global function
   creates it and passes it to the constructor. This change will not affect
   users who have always used `createClient` to create a `MatrixClient`.

New properties:
 * `User.events`
 * `RoomMember.events`

New features:
 * Local echo. When you send an event using the SDK it will immediately be
   added to `Room.timeline` with the `event.status` of `EventStatus.SENDING`. When
   the event is finally sent, this status will be removed.
 * Not sent status. When an event fails to send using the SDK, it will have the
   `event.status` of `EventStatus.NOT_SENT`.