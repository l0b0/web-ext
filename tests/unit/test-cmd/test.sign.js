import path from 'path';
import { promisify } from 'util';

import copyDir from 'copy-dir';
import { fs } from 'mz';
import { describe, it } from 'mocha';
import { assert } from 'chai';
import * as sinon from 'sinon';

import { UsageError } from '../../../src/errors.js';
import { AMO_BASE_URL } from '../../../src/program.js';
import { saveIdToFile } from '../../../src/util/submit-addon.js';
import { withTempDir } from '../../../src/util/temp-dir.js';
import completeSignCommand, {
  extensionIdFile,
  getIdFromFile,
} from '../../../src/cmd/sign.js';
import { basicManifest, manifestWithoutApps, fixturePath } from '../helpers.js';

describe('sign', () => {
  function getStubs() {
    const signingConfig = {
      amoBaseUrl: AMO_BASE_URL,
      apiKey: 'AMO JWT issuer',
      apiSecret: 'AMO JWT secret',
      apiUrlPrefix: 'http://not-the-real-amo.com/api/v4',
      timeout: 999,
      webextVersion: '12.34',
    };

    const buildResult = {
      extensionPath: '/tmp/built-web-extension.xpi',
    };
    const build = sinon.spy(() => Promise.resolve(buildResult));

    const signingResult = {
      id: 'some-addon-id',
      downloadedFiles: [],
    };
    const submitAddonResult = { ...signingResult };
    const submitAddon = sinon.spy(() => Promise.resolve(submitAddonResult));

    return {
      signingConfig,
      signingOptions: {
        build,
        preValidatedManifest: basicManifest,
        submitAddon,
      },
      buildResult,
      submitAddonResult,
      signingResult,
    };
  }

  /*
   * Run the sign command with stubs for all dependencies.
   */
  function sign(tmpDir, stubs, { extraArgs = {}, extraOptions = {} } = {}) {
    return completeSignCommand(
      {
        verbose: false,
        artifactsDir: path.join(tmpDir.path(), 'artifacts-dir'),
        sourceDir: tmpDir.path(),
        channel: 'listed',
        ...stubs.signingConfig,
        ...extraArgs,
      },
      {
        ...stubs.signingOptions,
        ...extraOptions,
      },
    );
  }

  it('builds and signs an extension', () =>
    withTempDir(
      // This test only stubs out the signer in an effort to integrate
      // all other parts of the process.
      (tmpDir) => {
        const stubs = getStubs();
        const sourceDir = path.join(tmpDir.path(), 'source-dir');
        const copyDirAsPromised = promisify(copyDir);
        const apiProxy = 'https://proxy.url';
        return copyDirAsPromised(fixturePath('minimal-web-ext'), sourceDir)
          .then(() =>
            completeSignCommand(
              {
                sourceDir,
                artifactsDir: path.join(tmpDir.path(), 'artifacts'),
                channel: 'listed',
                ...stubs.signingConfig,
                apiProxy,
              },
              {
                submitAddon: stubs.signingOptions.submitAddon,
              },
            ),
          )
          .then((result) => {
            assert.equal(result.id, stubs.signingResult.id);
            // Do a sanity check that a built extension was passed to the
            // signer.
            const submitAddonCall =
              stubs.signingOptions.submitAddon.firstCall.args[0];
            assert.include(
              submitAddonCall.xpiPath,
              'minimal_extension-1.0.zip',
            );
            assert.include(
              submitAddonCall.amoBaseUrl,
              stubs.signingConfig.amoBaseUrl,
            );
          });
      },
    ));

  it("doesn't allow a custom ID when no ID in manifest.json with submission api", () =>
    withTempDir(async (tmpDir) => {
      const customId = 'some-custom-id';
      const stubs = getStubs();
      const promiseSigned = sign(tmpDir, stubs, {
        extraArgs: {
          id: customId,
        },
        extraOptions: {
          preValidatedManifest: manifestWithoutApps,
        },
      });
      await assert.isRejected(promiseSigned, UsageError);
      await assert.isRejected(
        promiseSigned,
        /Cannot set custom ID some-custom-id/,
      );
      await assert.isRejected(
        promiseSigned,
        /requires a custom ID be specified in the manifest/,
      );
    }));

  it("doesn't allow ID file when no ID in manifest.json with submission api", () =>
    withTempDir(async (tmpDir) => {
      const sourceDir = path.join(tmpDir.path(), 'source-dir');
      const idFile = path.join(sourceDir, extensionIdFile);
      const stubs = getStubs();
      await fs.mkdir(sourceDir);
      await saveIdToFile(idFile, 'some-other-id');
      // Now, make a signing call with a custom ID.
      const promiseSigned = sign(tmpDir, stubs, {
        extraArgs: {
          sourceDir,
        },
        extraOptions: {
          preValidatedManifest: manifestWithoutApps,
        },
      });

      await assert.isRejected(promiseSigned, UsageError);
      await assert.isRejected(
        promiseSigned,
        /Cannot use previously auto-generated extension ID/,
      );
      await assert.isRejected(promiseSigned, /some-other-id - /);
      await assert.isRejected(
        promiseSigned,
        /requires a custom ID be specified in the manifest/,
      );
    }));

  it('disallows a custom ID when manifest.json has ID', () =>
    withTempDir(async (tmpDir) => {
      const customId = 'some-custom-id';
      const stubs = getStubs();
      const signPromise = sign(tmpDir, stubs, {
        extraArgs: {
          id: customId,
        },
        extraOptions: {
          // This manifest has an ID in it.
          preValidatedManifest: basicManifest,
        },
      });
      await assert.isRejected(signPromise, UsageError);
      await assert.isRejected(
        signPromise,
        /Cannot set custom ID some-custom-id/,
      );
      await assert.isRejected(
        signPromise,
        /manifest\.json declares ID basic-manifest@web-ext-test-suite/,
      );
    }));

  it('requires a channel for submission API', () =>
    withTempDir(async (tmpDir) => {
      const stubs = getStubs();
      const signPromise = sign(tmpDir, stubs, {
        extraArgs: {
          channel: '',
        },
        extraOptions: {
          preValidatedManifest: manifestWithoutApps,
        },
      });
      await assert.isRejected(signPromise, UsageError);
      await assert.isRejected(
        signPromise,
        /channel is a required parameter for the addon submission API/,
      );
    }));

  it('passes the apiProxy parameter to submissionAPI signer', () =>
    withTempDir((tmpDir) => {
      const stubs = getStubs();
      const apiProxy = 'https://proxy.url';
      return sign(tmpDir, stubs, {
        extraArgs: { apiProxy, channel: 'unlisted' },
      }).then(() => {
        sinon.assert.called(stubs.signingOptions.submitAddon);
        sinon.assert.calledWithMatch(stubs.signingOptions.submitAddon, {
          apiProxy,
        });
      });
    }));

  it('passes the uploadSourceCode parameter to submissionAPI signer as submissionSource', () =>
    withTempDir((tmpDir) => {
      const stubs = getStubs();
      const uploadSourceCode = 'path/to/source.zip';
      return sign(tmpDir, stubs, {
        extraArgs: {
          uploadSourceCode,
          useSubmissionApi: true,
          channel: 'unlisted',
        },
      }).then(() => {
        sinon.assert.called(stubs.signingOptions.submitAddon);
        sinon.assert.calledWithMatch(stubs.signingOptions.submitAddon, {
          submissionSource: uploadSourceCode,
        });
      });
    }));
  it('returns a signing result', () =>
    withTempDir((tmpDir) => {
      const stubs = getStubs();
      return sign(tmpDir, stubs).then((realResult) => {
        assert.deepEqual(realResult, stubs.signingResult);
      });
    }));

  it('calls the add-on submission api signer', () =>
    withTempDir((tmpDir) => {
      const stubs = getStubs();
      const artifactsDir = path.join(tmpDir.path(), 'some-artifacts-dir');
      const applications = stubs.signingOptions.preValidatedManifest
        .applications || {
        gecko: {},
      };
      const userAgentString = `web-ext/${stubs.signingConfig.webextVersion}`;
      const channel = 'unlisted';
      return sign(tmpDir, stubs, {
        extraArgs: { artifactsDir, channel },
      }).then(() => {
        sinon.assert.called(stubs.signingOptions.submitAddon);
        sinon.assert.calledWithMatch(stubs.signingOptions.submitAddon, {
          apiKey: stubs.signingConfig.apiKey,
          apiSecret: stubs.signingConfig.apiSecret,
          amoBaseUrl: stubs.signingConfig.amoBaseUrl,
          downloadDir: artifactsDir,
          id: applications.gecko?.id,
          validationCheckTimeout: stubs.signingConfig.timeout,
          approvalCheckTimeout: stubs.signingConfig.timeout,
          xpiPath: stubs.buildResult.extensionPath,
          channel,
          userAgentString,
        });
      });
    }));

  it('calls the add-on submission api signer with approval timeout', () =>
    withTempDir((tmpDir) => {
      const stubs = getStubs();
      const artifactsDir = path.join(tmpDir.path(), 'some-artifacts-dir');
      const applications = stubs.signingOptions.preValidatedManifest
        .applications || {
        gecko: {},
      };
      const userAgentString = `web-ext/${stubs.signingConfig.webextVersion}`;
      const channel = 'unlisted';
      const approvalCheckTimeout = 0;
      const validationCheckTimeout = 123;
      return sign(tmpDir, stubs, {
        extraArgs: {
          artifactsDir,
          channel,
          approvalTimeout: approvalCheckTimeout,
          timeout: validationCheckTimeout,
        },
      }).then(() => {
        sinon.assert.called(stubs.signingOptions.submitAddon);
        sinon.assert.calledWithMatch(stubs.signingOptions.submitAddon, {
          apiKey: stubs.signingConfig.apiKey,
          apiSecret: stubs.signingConfig.apiSecret,
          amoBaseUrl: stubs.signingConfig.amoBaseUrl,
          downloadDir: artifactsDir,
          id: applications.gecko?.id,
          validationCheckTimeout,
          approvalCheckTimeout,
          xpiPath: stubs.buildResult.extensionPath,
          channel,
          userAgentString,
        });
      });
    }));

  it('passes through a signing exception from submitAddon', () =>
    withTempDir(async (tmpDir) => {
      const stubs = getStubs();
      stubs.signingOptions.submitAddon = () =>
        Promise.reject(new Error('some signing error'));

      const signPromise = sign(tmpDir, stubs);
      await assert.isRejected(signPromise, /signing error/);
    }));

  it('parses listing metadata as JSON and passes through to submitAddon', () =>
    withTempDir(async (tmpDir) => {
      const stubs = getStubs();
      const metaDataJson = { version: { license: 'MPL2.0' } };
      const amoMetadata = 'path/to/metadata.json';
      const asyncFsReadFileStub = sinon.spy(() =>
        Promise.resolve(new Buffer(JSON.stringify(metaDataJson))),
      );

      return sign(tmpDir, stubs, {
        extraArgs: {
          amoMetadata,
        },
        extraOptions: {
          asyncFsReadFile: asyncFsReadFileStub,
        },
      }).then(() => {
        sinon.assert.called(stubs.signingOptions.submitAddon);
        sinon.assert.calledWithMatch(stubs.signingOptions.submitAddon, {
          metaDataJson,
        });
        sinon.assert.calledWith(asyncFsReadFileStub, amoMetadata);
      });
    }));

  it('raises an error on invalid JSON', () =>
    withTempDir(async (tmpDir) => {
      const stubs = getStubs();
      const amoMetadata = 'path/to/metadata.json';
      const asyncFsReadFileStub = sinon.spy(() =>
        Promise.resolve(new Buffer('{"broken":"json"')),
      );

      const signPromise = sign(tmpDir, stubs, {
        extraArgs: { amoMetadata },
        extraOptions: {
          asyncFsReadFile: asyncFsReadFileStub,
        },
      });
      await assert.isRejected(signPromise, UsageError);
      await assert.isRejected(signPromise, /Invalid JSON in listing metadata/);
      sinon.assert.calledWith(asyncFsReadFileStub, amoMetadata);
    }));

  describe('getIdFromFile', () => {
    it('gets a saved extension ID', () =>
      withTempDir((tmpDir) => {
        const idFile = path.join(tmpDir.path(), extensionIdFile);
        return saveIdToFile(idFile, 'some-id')
          .then(() => getIdFromFile(idFile))
          .then((extensionId) => {
            assert.equal(extensionId, 'some-id');
          });
      }));

    it('throws an error for empty files', () =>
      withTempDir(async (tmpDir) => {
        const idFile = path.join(tmpDir.path(), extensionIdFile);
        await fs.writeFile(idFile, '');
        const getIdPromise = getIdFromFile(idFile);
        await assert.isRejected(getIdPromise, UsageError);
        await assert.isRejected(
          getIdPromise,
          /No ID found in extension ID file/,
        );
      }));

    it('returns empty ID when extension file does not exist', () =>
      withTempDir((tmpDir) => {
        const idFile = path.join(tmpDir.path(), extensionIdFile);
        return getIdFromFile(idFile).then((savedId) => {
          assert.strictEqual(savedId, undefined);
        });
      }));

    it('throws unexpected errors', async () => {
      const fakeAsyncFsReadFile = sinon.spy(async () => {
        throw new Error('Unexpected fs.readFile error');
      });
      await assert.isRejected(
        getIdFromFile('fakeIdFile', fakeAsyncFsReadFile),
        /Unexpected fs.readFile error/,
      );

      sinon.assert.calledOnce(fakeAsyncFsReadFile);
    });
  });
});
