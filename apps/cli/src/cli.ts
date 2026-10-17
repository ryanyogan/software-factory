#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { globalArgs } from './args';

const main = defineCommand({
  meta: { name: 'sf', version: '0.0.0', description: 'Software Factory CLI' },
  args: globalArgs,
  // Lazy: each subcommand (and @sf/contract/zod) loads only when invoked.
  subCommands: {
    project: () => import('./commands/project').then((m) => m.default),
    task: () => import('./commands/task').then((m) => m.default),
    run: () => import('./commands/run').then((m) => m.default),
    watch: () => import('./commands/watch').then((m) => m.default),
    link: () => import('./commands/link').then((m) => m.link),
    unlink: () => import('./commands/link').then((m) => m.unlink),
    daemon: () => import('./commands/daemon').then((m) => m.default),
    open: () => import('./commands/open').then((m) => m.default),
    login: () => import('./commands/auth').then((m) => m.login),
    logout: () => import('./commands/auth').then((m) => m.logout),
    whoami: () => import('./commands/auth').then((m) => m.whoami),
  },
});

void runMain(main);
