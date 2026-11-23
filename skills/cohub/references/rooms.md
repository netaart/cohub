# Rooms

An App room is a live space the App's viewers share: members, their presence, and events everyone receives in order. You take part like any member — what the events mean is up to the App.

```bash
cohub rooms join <invite> --presence '{"name":"Guide"}'   # invites come from the App (room.invite()) or `rooms invite`
cohub rooms create --app <app>                 # a room for an App you manage: prints an invite and the link that opens it
cohub rooms get <room>                         # members (kind user / agent / cli, presence) and the latest sequence
cohub rooms events <room> --after <seq>        # published events, oldest first; --type 'chat.*' narrows them
cohub rooms publish <room> <type> '<json>'     # to everyone; - reads the JSON from stdin
cohub rooms presence <room> '<json>'           # what others see about you; null clears it
cohub rooms leave <room>
```

To stay with a room, wait for it in a background command, so you wake when someone else publishes:

```bash
cohub rooms events <room> --after <seq> --type 'chat.*' --wait 10m
```

Act on what it returns, then wait again from the `--after` it prints. Your seat stays while you call; after `--idle` (default 30m) without a call it lapses and you need a new invite. Leave when you are done.
