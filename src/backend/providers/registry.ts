import tencent from './tencent';
import microsoft from './microsoft';
import deepl from './deepl';
import niutrans from './niutrans';
import llamacpp from './llamacpp';
import openai from './openai-compatible';
import gemini from './gemini';
import remote from './remote-node';
import browserTranslator from './browser-translator';
import googleWeb from './unofficial/google-web';
import type { ProviderDef } from './types';

export const providers: ProviderDef[] = [microsoft, deepl, niutrans, tencent, browserTranslator, llamacpp, openai, gemini, remote, googleWeb];
