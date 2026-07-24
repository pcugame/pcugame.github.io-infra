import type {
	AppLogger,
	FileSystem,
} from '../application/ports.js';
import type { ProjectUploadProcessing } from '../modules/admin/project/project-upload.adapter.js';
import { validateProjectUploadFile } from '../modules/admin/project/project-file-validation.js';
import { processImage } from '../modules/assets/upload/image-processing.js';
import { processPdf } from '../modules/assets/upload/pdf-processing.js';
import { processVideo } from '../modules/assets/upload/video-processing.js';
import { createNodeVideoProcessingOperations } from '../modules/assets/upload/video-processing.compatibility.js';

/**
 * Node/sharp/ffmpeg adapter. The project application graph sees only
 * ProjectUploadProcessing; all filesystem access is routed through the
 * FileSystem owned by the same BackendContext.
 */
export function createNodeProjectUploadProcessing(
	fileSystem: FileSystem,
	logger: AppLogger,
): ProjectUploadProcessing {
	const videoOperations = createNodeVideoProcessingOperations(fileSystem);
	return {
		validate: (filePath, kind) => validateProjectUploadFile(
			fileSystem,
			filePath,
			kind,
		),
		processImage: (input) => processImage(input, fileSystem),
		processPdf: (input) => processPdf(input, logger, fileSystem),
		processVideo: (input) => processVideo(input, logger, videoOperations),
	};
}
