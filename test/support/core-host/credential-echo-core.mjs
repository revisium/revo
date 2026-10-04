const PROTOCOL = 'revo-core-host/v1';

/** A Core host that prints its database credentials before failing, as a careless library might. */
process.on('message', (message) => {
  if (message?.type === 'hello') {
    process.send?.({ protocol: PROTOCOL, type: 'booted' });
    return;
  }
  if (message?.type === 'start') {
    const password = new URL(message.databaseUrl).password;
    process.stdout.write(`Core echoed ${message.databaseUrl}\n`);
    process.stderr.write(`Core password ${password} decoded ${decodeURIComponent(password)}\n`);
    process.send?.({ protocol: PROTOCOL, type: 'failed', code: 'CORE_HOST_FAILED' }, () =>
      process.exit(1),
    );
    return;
  }
  if (message?.type === 'shutdown') {
    process.exit(0);
  }
});
