/* eslint no-await-in-loop: 0 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {once, EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {setTimeout} from 'node:timers/promises';

import AMI from 'ami';
import pMap from 'p-map';
import which from 'which';
import vinylFS from 'vinyl-fs';
import {FixtureRunDirectory} from '@cfware/fixture-run-directory';

const execFile = promisify(childProcess.execFile);

const __dirname = fileURLToPath(path.dirname(import.meta.url));

const findAddressOctets = [127, 0, 0, 0];
let addressesDepleted = false;
function nextAddress() {
	let octet = 3;
	if (!addressesDepleted) {
		while (octet > 0) {
			findAddressOctets[octet]++;
			if (findAddressOctets[octet] < 255) {
				return findAddressOctets.join('.');
			}

			findAddressOctets[octet] = 0;
			octet--;
		}
	}

	addressesDepleted = true;
	throw new Error('Out of addresses');
}

async function copyFiles(source, destination) {
	await pipeline(vinylFS.src(source), vinylFS.dest(destination));
}

export class AsteriskInstance extends FixtureRunDirectory {
	#serverHold = createServer();
	#astdirs = {
		astetcdir: 'etc/asterisk',
		astvarlibdir: 'var/lib/asterisk',
		astdbdir: 'var/spool',
		astkeydir: 'var/lib/asterisk',
		astdatadir: 'var/lib/asterisk',
		astspooldir: 'var/spool',
		astrundir: 'run',
		astlogdir: 'var/log'
	};

	asteriskConf = this.astdir('astetcdir', 'asterisk.conf');
	directories = Object.keys(this.#astdirs);
	amiEvents = new EventEmitter();

	collectEvents(name) {
		const list = [];
		const collectionCB = asObject => list.push(asObject);
		this.amiEvents.on(name, collectionCB);
		return {
			list,
			stop: () => this.amiEvents.off(name, collectionCB)
		};
	}

	astdir(key, ...args) {
		return this.runPath(this.#astdirs[key], ...args);
	}

	async installConfigs(id) {
		await copyFiles(
			this.fixturePath(`asterisk-${id}/**/*.conf`),
			this.astdir('astetcdir')
		);
	}

	assignAddress() {
		if (this.serverAddress) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			let address;
			const listen = () => {
				address = nextAddress();
				this.#serverHold.listen(29999, address);
			};

			this.#serverHold.on('error', error => {
				if (error.code !== 'EADDRINUSE') {
					return reject(error);
				}

				this.#serverHold.close();
				listen();
			});

			this.#serverHold.on('listening', () => {
				this.serverAddress = address;
				resolve();
			});

			listen();
		});
	}

	async build() {
		await this.assignAddress();
		this.ami = new AMI({
			connect: {
				host: this.serverAddress,
				port: 5038
			}
		});
		this.ami.on('event', ({asObject}) => {
			this.amiEvents.emit(asObject.event.toLowerCase(), asObject);
		});

		this.bin = await which('asterisk');

		const directories = Object.fromEntries(this.directories.map(id => [id, ['']]));
		Object.assign(directories, {
			astvarlibdir: [
				'keys',
				'moh',
				'documentation',
				'sounds/en/silence'
			],
			astetcdir: [
				'acl.d',
				'cli_permissions.d',
				'confbridge.d',
				'extensions.d',
				'http.d',
				'manager.d',
				'musiconhold.d',
				'pjsip.d',
				'sorcery.d'
			]
		});

		/* Make directories */
		await pMap(
			Object.entries(directories).flatMap(
				([key, directories]) => directories.map(directory => this.astdir(key, directory))
			),
			directory => fs.mkdir(directory, {recursive: true})
		);

		await fs.writeFile(this.runPath('asterisk'), [
			'#!/usr/bin/env sh',
			`exec ${this.bin} -C "${this.asteriskConf}" "$@"`,
			''
		].join('\n'));
		await fs.chmod(this.runPath('asterisk'), 0o775);

		/* Copy documentation */
		await copyFiles(
			path.join(__dirname, 'documentation/**'),
			this.astdir('astvarlibdir', 'documentation')
		);

		/* Copy audio */
		await copyFiles(
			path.join(__dirname, 'sounds/**'),
			this.astdir('astvarlibdir', 'sounds/en')
		);

		/* Copy initial generic configs */
		await copyFiles(
			path.join(__dirname, 'configs/**'),
			this.astdir('astetcdir')
		);

		/* Generate IP based configs */
		await fs.writeFile(this.astdir('astetcdir', 'bindaddr.conf'), `bindaddr=${this.serverAddress}\n`);
		await fs.writeFile(this.astdir('astetcdir', 'pjsip-bind.conf'), `bind=${this.serverAddress}:5060\n`);

		/* Copy user provided configs */
		await this.installConfigs(this.instanceID);

		/* Generate basic asterisk.conf for directories */
		await fs.writeFile(this.astdir('astetcdir', 'asterisk.conf'), [
			'[directories]',
			...this.directories.map(id => `${id}=${this.astdir(id)}`),
			'',
			`#include ${this.astdir('astetcdir', 'asterisk-options.conf')}`,
			''
		].join('\n'));
	}

	async start() {
		this.asteriskProcess = execFile(this.bin, [
			'-f',
			'-C',
			this.asteriskConf
		]);

		try {
			await this.fullyBooted();
		} catch (error) {
			this.asteriskProcess.child.kill(9);
			this.asteriskProcess = undefined;
			throw error;
		}

		this.ami.on('event', packet => {
			if (this.amiTracer) {
				this.amiTracer.write(',\n\t');
			} else {
				this.amiTracer = createWriteStream(this.astdir('astlogdir', 'ami-events.json'));
				this.amiTracer.write('[\n\t');
			}

			this.amiTracer.write(JSON.stringify(packet.asObject));
		});

		await this.ami.connect();
	}

	get _refdebugLog() {
		return this.astdir('astlogdir', 'refs');
	}

	async _refdebugEnabled() {
		try {
			await fs.stat(this._refdebugLog);
			return true;
		} catch {
			return false;
		}
	}

	async stop() {
		if (!this.asteriskProcess) {
			return;
		}

		const {asteriskProcess} = this;
		this.asteriskProcess = undefined;

		if (await this._refdebugEnabled()) {
			await setTimeout(6400);
		}

		await this.cliCommand('core stop gracefully').catch(() => {});
		await asteriskProcess;

		this.ami.removeAllListeners('event');
		if (this.amiTracer) {
			this.amiTracer.end('\n]');
			await once(this.amiTracer, 'close');
		}

		this.#serverHold.unref();
	}

	async checkStopped() {
		const python = await which('python3');
		if (await this._refdebugEnabled()) {
			await execFile(python, [
				path.join(__dirname, 'scripts/refcounter.py'),
				'-f',
				this._refdebugLog,
				'-n'
			]);
		}
	}

	cliCommand(command) {
		if (!this.bin) {
			throw new Error('Not started');
		}

		return execFile(this.bin, [
			'-C',
			this.asteriskConf,
			'-rx',
			command
		]);
	}

	async fullyBooted() {
		let attempt = 0;
		while (attempt < 100) {
			try {
				await setTimeout(100);
				await this.cliCommand('core waitfullybooted');
				return;
			} catch {
				attempt++;
			}
		}

		throw new Error('Failed to start asterisk');
	}
}

export function setupIntegrationAMITesting(tap, integrationInstance) {
	const {Test} = tap;

	Test.addAssert('checkAMIEvents', 2, async function ({instanceID, watch, expect, execute}, message, extra) {
		const {ami} = integrationInstance[instanceID ?? 'defaultInstance'];

		watch = [].concat(watch).map(eventName => eventName.toLowerCase());
		const events = [];
		const listener = ({asObject}) => {
			if (watch.includes(asObject.event.toLowerCase())) {
				events.push(asObject);
			}
		};

		ami.on('event', listener);
		const result = await execute();
		await setTimeout(50);
		ami.off('event', listener);

		this.equal(events.length, expect.length, 'events.length matches', extra);
		this.match(events, expect, message || 'events match', extra);

		return result;
	});
}
