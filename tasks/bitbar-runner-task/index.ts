import * as tl from "azure-pipelines-task-lib/task";
import EventEmitter from 'events';
import fs, { promises as fsAsync } from 'fs';
import path, { resolve } from 'path';
const { readdir } = require('fs').promises;
import archiver from 'archiver';
import axios from 'axios';

import CloudApiClient from '@bitbar/cloud-api-client';
import API from '@bitbar/cloud-api-client/dist/API';

// Disable max content length
axios.defaults.maxContentLength = 1073741824; // 1GB
axios.defaults.maxBodyLength = 1073741824; // 1GB

export class BBClient {
    apiKey: string | undefined = tl.getInput('apiKey', true);
    taskType: string | undefined = tl.getInput('taskType', true);

    defaultOutput: string | undefined = tl.getInput('defaultOutput', false);
    appFilePath: string | undefined = tl.getInput('appFilePath', true);

    // upload type variables
    accessGroupIds: string | undefined = tl.getInput('accessGroupIds', false);

    // run type variables
    testsFilePath: string | undefined = tl.getInput('testsFilePath', false);
    testsRunParams: string | undefined = tl.getInput('testsRunParams', false);
    environmentVariables: string | undefined = tl.getInput('environmentVariables', false);
    projectId: string | undefined = tl.getInput('projectId', false);
    // todo: make optional
    testArchiveName: string | undefined = tl.getInput('testArchiveName', false);
    deviceIds: string | undefined = tl.getInput('deviceIds', false);
    deviceGroupId: string | undefined = tl.getInput('deviceGroupId', false);
    testRunName: string | undefined = tl.getInput('testRunName', false);
    osType: string | undefined = tl.getInput('osType', false);

    bus = new EventEmitter();
    apiClient!: API;

    f = new CloudApiClient.FilterBuilder();

    public async Run() {
        try {
            const paramsValidationResult = this.validateInputParameters();
            if (paramsValidationResult) {
                tl.setResult(tl.TaskResult.Failed, paramsValidationResult);
                return;
            }

            this.apiClient = new CloudApiClient.API({
                baseURL: '',
                cloudUrl: 'https://cloud.bitbar.com',
                apiKey: this.apiKey,
                v2: true
            });

            await this.printAvailableDeviceGroupsAndDevices();

            switch (this.taskType) {
                case "run":
                    await this.doRunTests();
                    break;

                case "upload":
                    await this.doUpload();
                    break;

                default:
                    throw "Not supported type of run.";
            }
        }
        catch (ex) {
            this.processError(ex);
            throw ex;
        }
    }

    private validateInputParameters() {
        if (!this.apiKey || this.apiKey == '') {
            return 'The parameter apiKey is required';
        }
        if (!this.appFilePath || this.appFilePath === '') {
            return 'The parameter appFilePath is required';
        }

        if (!this.taskType || this.taskType === 'run') {
            if (!this.testRunName || this.testRunName === '') {
                return 'The parameter testRunName is required';
            }
            if (!this.defaultOutput || this.defaultOutput === '') {
                return 'The parameter defaultOutput is required';
            }
            if (!this.deviceIds && !this.deviceGroupId) {
                return 'The parameter deviceIds or deviceGroupId should be define';
            }
            if (!this.testsFilePath || this.testsFilePath === '') {
                return 'The parameter testsFilePath is required';
            }
            if (!this.projectId || this.projectId === '') {
                return 'The parameter projectId is required';
            }
            if (!this.osType || this.osType === '') {
                return 'The parameter osType is required';
            }
        }
    }

    private async doUpload() {
        const files = await this.uploadFiles([
            { id: -1, filePath: this.appFilePath!, replace: true }
        ]);

        if (this.accessGroupIds !== "") {
            for (const file of files) {
                await this.shareAccess(file.id);
            }
        }
    }

    private async shareAccess(fileId: number) {
        const groups = this.accessGroupIds?.split(',');
        if (groups) {
            for (const groupId of groups) {
                try {
                    const file = await this.apiClient.me().file(fileId).send();
                    if (file.data.shared) {
                        console.log('This file was already shared, no need to share again');
                    }
                    else {
                        await this.apiClient.axios.post(this.apiClient.me().file(fileId).toUrl() + "/share?accessGroupId=" + groupId);
                        console.log("File shared sucessfully");
                    }
                } catch (ex) {
                    this.processError(ex);
                    throw ex;
                }
            }
        }
    }

    private async doRunTests() {
        // prepare archive
        const defaultOutput = this.defaultOutput || './dist';
        if (!fs.existsSync(defaultOutput!)) {
            fs.mkdirSync(defaultOutput!);
        }

        const uiTestsDirName = path.dirname(this.testsFilePath!);
        const testFileName = path.basename(this.testsFilePath!);
        const testArchiveName = this.testArchiveName! || 'tests.zip';
        await this.makeArchivetoUpload(testFileName, uiTestsDirName, testArchiveName, defaultOutput);

        // upload files
        const filesResult = await this.uploadFiles([
            { id: -1, filePath: path.join(defaultOutput, testArchiveName), replace: false },
            { id: -1, filePath: this.appFilePath!, replace: false }
        ]);

        const arrayOfdeviceIds = this.deviceIds?.split(',').map(item => item);

        // prepare config
        let config = {
            testRunName: this.testRunName,
            projectId: this.projectId,
            scheduler: "PARALLEL",
            timeout: 1800,
            deviceLanguageCode: "en_US",
            osType: this.osType,
            frameworkId: this.osType === 'IOS' ? 542 : 541,
            files: [
                {
                    id: filesResult[0].id,
                    action: "RUN_TEST",
                },
                {
                    id: filesResult[1].id,
                    action: "INSTALL",
                }
            ],
            projectName: 'Project created with JS API Client'
        } as any;

        if (this.deviceGroupId) {
            config = { deviceGroupId: this.deviceGroupId, ...config };
        }

        if (this.deviceIds) {
            config = { deviceIds: arrayOfdeviceIds, ...config };
        }

        // check if config is OK
        try {
            console.log('Config to run:');
            console.log(config);
            const checkConfigResponse = await this.apiClient.me().runs().config().post().jsonData(config).send();
            this.verifySendResult(checkConfigResponse);

            let keepRun = true;
            let keepRunCount = 0;
            const keepRunCountMax = 20;
            while (keepRun) {
                if (keepRunCount >= keepRunCountMax) {
                    keepRun = false;
                    throw `The maximum tries count is more or equal to: '${keepRunCountMax}'. Stop execution.`;
                }

                keepRun = (await this.RunTest(config)) === false;
                if (keepRun) {
                    console.log('Waiting 60 sec.');
                    await sleep(60000);
                    keepRunCount++;
                }
            }

            console.log('Execution done. Clean-up')
            for (const file of filesResult) {
                await this.deleteFile(file.id);
            }
        } catch (ex: any) {
            this.processError(ex);
            throw ex;
        }
    }

    private async RunTest(config: any) {
        try {
            // start a new test run
            const runResult = await this.apiClient.me().runs().post().jsonData(config).send();
            console.log('Start a new test run.');
            this.verifySendResult(runResult);

            const runId = runResult.data.id;
            let runState = runResult.data.state;
            while (runState == 'WAITING' || runState == 'RUNNING') {
                const getRunResult = await this.apiClient.me().project(+this.projectId!).run(runId).send();
                this.verifySendResult(getRunResult);

                runState = getRunResult.data.state;

                if (runState == 'FINISHED') {
                    console.log(runState)
                    const failedCount = getRunResult.data.failedTestCaseCount;
                    if (failedCount > 0) {
                        throw `Tests failed: ${getRunResult.data.uiLink}`;
                    }
                    console.log(`Tests passed: ${getRunResult.data.uiLink}`);
                } else {
                    console.log(`Status: ${runState}. Sleep for 20sec.`);
                    await sleep(20000);
                }
            }
            return true;
        } catch (error) {
            const ex = error as any;
            if (ex?.response?.status == 412) {
                console.log('You reached the account queue limit.');
                return false;
            }

            this.processError(ex);
            throw ex;
        }
    }

    private async uploadFiles(files: { id: number, filePath: string, replace: boolean }[]) {
        // check files
        const filesResult = await this.searchByFileName(files.map(x => path.basename(x.filePath)));

        // Add or Update files  
        for (let i = 0; i < files.length; i++) {
            const f = files[i];

            if (f.replace === true) {
                // remove old one
                for (const fileId of filesResult.filter(x => x.name == path.basename(f.filePath)).map(x => x.id)) {
                    await this.deleteFile(fileId);
                }
            }

            // upload new one
            files[i].id = await this.uploadFile(f.filePath);
        }

        console.log('Uploading done.');
        return files;
    }

    private createRunTestScript(testFileName: string): string {
        // file run-tests.sh.template will be created or overwritten by default.
        try {
            let variablesStr = ''
            if (this.environmentVariables) {
                const variables = this.environmentVariables.split(',');
                variables.forEach(x => {
                    variablesStr += `export ${x}\n`;
                });
            }

            const result = this.getTestRunScript()
                .replace(/{{TEST_FILE}}/g, testFileName)
                .replace(/{{ENVIRONMENT_VARIABLES_PLACE}}/g, variablesStr)
                .replace(/{{NUNIT_RUN_PARAMS}}/g, this.testsRunParams || '')
                ;

            console.log('Run script: \n' + unescape(result));
            return result;
        } catch (ex) {
            this.processError(ex);
            throw ex;
        }
    }

    private makeArchivetoUpload(testFileName: string, testDir: string, archiveName: string, outputDir: string) {
        console.log(`Folder to ZIP: ${testDir}`)

        const output = fs.createWriteStream(outputDir + '/' + archiveName);
        const archive = archiver('zip');

        output.on('close', () => {
            console.log(archive.pointer() + ' total bytes');
            console.log('archiver has been finalized and the output file descriptor has closed.');
            this.bus.emit('makeArchivetoUpload_unlocked');
        });

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(output);

        // append the run.sh file from string
        // build run script
        const runTestShContent = this.createRunTestScript(testFileName!);
        archive.append(runTestShContent, { name: 'run-tests.sh' });

        // append files from a directory, putting its contents at the root of archive
        archive.directory(testDir, false);

        archive.finalize();

        return new Promise(resolve => this.bus.once('makeArchivetoUpload_unlocked', resolve));
    }

    private async searchByFileName(filename: string[]): Promise<{ id: number, name: string }[]> {
        console.log(`Searching for files: '${filename}'`);

        // send request
        const filesResult = await this.apiClient.me().files().filter(this.f.in('name', filename)).send();
        this.verifySendResult(filesResult);

        // read response
        const files = filesResult?.data?.data as Array<any>;
        return files.map(x => ({ id: x.id, name: x.name }));
    }

    private async updateFileContent(id: number, filePath: string): Promise<number> {
        console.log(`Updating file content: '${id}: ${filePath}'`);

        try {
            let form;

            const fs = require('fs');
            const FormData = require('form-data');
            const filename = path.basename(filePath)
            form = new FormData();
            form.append('file', fs.createReadStream(filePath), {
                filename: filename
            });

            // send request
            const updateResult = await this.apiClient.me().file(id).file().post().headers(form.getHeaders()).data(form).send();
            this.verifySendResult(updateResult);

            return updateResult.data.id;
        } catch (ex) {
            this.processError(ex);
            throw ex;
        }
    }

    private async uploadFile(filePath: string): Promise<number> {
        console.log(`Uploading new file: '${filePath}'`);

        try {
            // send request
            const fp = path.parse(filePath);
            const uploadResult = await this.apiClient.me().files().upload({
                dir: fp.dir,
                filename: fp.base
            }).send();
            this.verifySendResult(uploadResult);

            return uploadResult.data.id;
        } catch (ex) {
            this.processError(ex);
            throw ex;
        }
    }

    private async deleteFile(fileId: number): Promise<boolean> {
        console.log(`Delete file: '${fileId}'`);

        try {
            // send request
            const deleteResult = await this.apiClient.me().file(fileId).delete().send();
            this.verifySendResult(deleteResult);
            return true;
        } catch (ex) {
            this.processError(ex);
            throw ex;
        }
    }

    private async printAvailableDeviceGroupsAndDevices() {
        const groups = await this.apiClient.me().deviceGroups().send();
        console.log('######################################################### Available Device Groups found on BitBar #########################################################');
        for (const group of groups.data.data) {
            console.log('DeviceGroupId: ' + group.id + ' - ' + group.displayName);

            const devices = await this.apiClient.me().deviceGroup(group.id).devices().send();
            for (const device of devices.data.data) {
                console.log('\tDeviceId: ' + device.id + ' - ' + device.displayName);
            }
        }
        console.log('######################################################### End of Available Device Groups found on BitBar #########################################################');
    }

    private verifySendResult(response: any) {
        if (!response) {
            throw `No response.`;
        }

        if (response?.status < 200 || response?.status >= 300) {
            throw `Responce:  ${response?.response?.data?.message}, code: ${response.status}`;
        }
    }

    private processError(error: any) {
        if (error?.response?.data?.message) {
            console.log(error.response.data.message);
        } else {
            console.log(error);
        }

        tl.setResult(tl.TaskResult.Failed, error);
    }

    private getTestRunScript(): string {
        return `
#!/bin/bash
# Name of the test file
TEST=\${TEST:="{{TEST_FILE}}"}
##### Cloud testrun dependencies start
echo "Extracting tests.zip..."
unzip tests.zip
#########################################################
#
# Intalling dotnet
#
#########################################################
curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel LTS
#########################################################
#
# Preparing to start Appium
# - UDID is the device ID on which test will run and
#   required parameter on iOS test runs
# - appium - is a wrapper tha calls the latest installed
#   Appium server. Additional parameters can be passed
#   to the server here.
#
#########################################################
echo "Setting UDID..."
echo "UDID set to \${IOS_UDID}"
echo "Starting Appium ..."
appium -U \${IOS_UDID}  --log-no-colors --log-timestamp --command-timeout 120
ps -ef|grep appium
##### Cloud testrun dependencies end.

## Clean local screenshots directory
rm -rf screenshots

## Start test execution
echo "Running test \${TEST}"
{{ENVIRONMENT_VARIABLES_PLACE}}
/Users/testdroid/.dotnet/dotnet test --logger:"junit;LogFilePath=test-result.xml" \${TEST} {{NUNIT_RUN_PARAMS}}

#########################################################
#
# Get test report
# - do any test result post processing your test results
#   need here
# - also any additional files can be retrieved here
# - retrieve files from device
#########################################################
mv test-result.xml TEST-all.xml

# Make sure there's no pre-existing screenshots file blocking symbolic link creation
rm -rf screenshots

# Screenshots need to be available at root as directory screenshots.
mkdir screenshots
cp -Rf *.png screenshots

ls -lrt

`;
    }
}

new BBClient().Run();

async function sleep(millis: number) {
    return new Promise(resolve => setTimeout(resolve, millis));
}
