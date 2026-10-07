import { z } from 'zod';
import { PROJECT_PLATFORMS } from './enums.js';

export const PlatformSchema = z.enum(PROJECT_PLATFORMS);
export const PlatformsSchema = z.array(PlatformSchema).max(PROJECT_PLATFORMS.length);
export const MAX_HARDWARE_REQUIREMENTS_LENGTH = 1000;
export const HardwareRequirementsSchema = z.string().trim().max(MAX_HARDWARE_REQUIREMENTS_LENGTH);
