// LICENSE : MIT
"use strict";
const debug = require("debug")("textlint:fixer-processor");
import * as assert from "assert";
import FixerTask from "../task/fixer-task";
import SourceCode from "../core/source-code";
import SourceCodeFixer from "./source-code-fixer";
import TaskRunner from "../task/task-runner";
import { hasFixer } from "../core/rule-creator-helper";
import {
    TextlintFixResult,
    TextlintKernelConstructorOptions,
    TextlintKernelFilterRule,
    TextlintKernelProcessor,
    TextlintKernelRule,
    TextlintMessage
} from "../textlint-kernel-interface";
import MessageProcessManager from "../messages/MessageProcessManager";

export interface FixerProcessorProcessArgs {
    config: TextlintKernelConstructorOptions;
    configBaseDir?: string;
    rules?: TextlintKernelRule[];
    filterRules?: TextlintKernelFilterRule[];
    sourceCode: SourceCode;
}

export default class FixerProcessor {
    private processor: TextlintKernelProcessor;
    private messageProcessManager: MessageProcessManager;

    /**
     * @param {Processor} processor
     * @param {MessageProcessManager} messageProcessManager
     */
    constructor(processor: TextlintKernelProcessor, messageProcessManager: MessageProcessManager) {
        this.processor = processor;
        this.messageProcessManager = messageProcessManager;
    }

    /**
     * Run fixer process
     * @param {Config} config
     * @param {string} [configBaseDir]
     * @param {TextlintKernelRule[]} [rules]
     * @param {TextlintKernelFilterRule[]} [filterRules]
     * @param {SourceCode} sourceCode
     * @returns {Promise.<TextlintFixResult>}
     */
    process({
        config,
        configBaseDir,
        rules = [],
        filterRules = [],
        sourceCode
    }: FixerProcessorProcessArgs): Promise<TextlintFixResult> {
        assert(config && Array.isArray(rules) && Array.isArray(filterRules) && sourceCode);
        const { preProcess, postProcess } = this.processor.processor(sourceCode.ext);
        // messages
        let resultFilePath = sourceCode.filePath;
        // applied fixing messages
        // Revert = Sequentially apply applied message to applied output
        // SourceCodeFixer.sequentiallyApplyFixes(fixedOutput, result.applyingMessages);
        const applyingMessages: TextlintMessage[] = [];
        // not applied fixing messages
        const remainingMessages: TextlintMessage[] = [];
        // original means original for applyingMessages and remainingMessages
        // pre-applyingMessages + remainingMessages
        const originalMessages: TextlintMessage[] = [];
        const fixerProcessList = rules
            .filter(rule => {
                return hasFixer(rule.rule);
            })
            .map(fixerRule => {
                return (sourceText: string): Promise<string> => {
                    // create new SourceCode object
                    const newSourceCode = new SourceCode({
                        text: sourceText,
                        ast: preProcess(sourceText),
                        filePath: resultFilePath,
                        ext: sourceCode.ext
                    });
                    // create new Task
                    const task = new FixerTask({
                        config,
                        fixerRule,
                        filterRules,
                        sourceCode: newSourceCode,
                        configBaseDir
                    });

                    return TaskRunner.process(task).then(messages => {
                        const result = postProcess(messages, sourceCode.filePath);
                        const filteredResult = {
                            messages: this.messageProcessManager.process(result.messages),
                            filePath: result.filePath ? result.filePath : `<Unkown${sourceCode.ext}>`
                        };
                        // TODO: should be removed resultFilePath
                        resultFilePath = filteredResult.filePath;
                        const applied = SourceCodeFixer.applyFixes(newSourceCode, filteredResult.messages);
                        // add messages
                        Array.prototype.push.apply(applyingMessages, applied.applyingMessages);
                        Array.prototype.push.apply(remainingMessages, applied.remainingMessages);
                        Array.prototype.push.apply(originalMessages, applied.messages);
                        // if not fixed, still use current sourceText
                        if (!applied.fixed) {
                            return sourceText;
                        }
                        // if fixed, use fixed text at next
                        return applied.output;
                    });
                };
            });

        const promiseTask = fixerProcessList.reduce((promise, fixerProcess) => {
            return promise.then(sourceText => {
                return fixerProcess(sourceText);
            });
        }, Promise.resolve(sourceCode.text));

        return promiseTask.then(output => {
            debug(`Finish Processing: ${resultFilePath}`);
            debug(`applyingMessages: ${applyingMessages.length}`);
            debug(`remainingMessages: ${remainingMessages.length}`);
            return {
                filePath: resultFilePath ? resultFilePath : `<Unkown${sourceCode.ext}>`,
                output,
                messages: originalMessages,
                applyingMessages,
                remainingMessages
            };
        });
    }
}
