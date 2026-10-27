import { cli } from '@sovovs/bycli/registry';
import { makeVideoDownloadCommand } from '../_shared/video-download.js';

export const downloadCommand = cli(makeVideoDownloadCommand('tiktok'));
