/**
 * Client-side file operations for CLI mode.
 * Communicates with the file API server started by the CLI.
 */

interface FileConfig {
  file: string | null;
  fileName: string | null;
  readOnly: boolean;
  newFile: boolean;
}

interface FileData {
  content: string;
}

export class FileClient {
  private apiPort: number | null = null;
  private config: FileConfig | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastSavedContent: string = '';

  constructor() {
    this.detectApiPort();
  }

  private detectApiPort(): void {
    const params = new URLSearchParams(window.location.search);
    const port = params.get('apiPort');
    if (port) {
      this.apiPort = parseInt(port, 10);
    }
  }

  /**
   * Check if we're running in CLI mode (with file API available)
   */
  isCliMode(): boolean {
    return this.apiPort !== null;
  }

  /**
   * Get the API base URL
   */
  private getApiUrl(): string {
    return `http://localhost:${this.apiPort}`;
  }

  /**
   * Fetch configuration from the CLI server
   */
  async fetchConfig(): Promise<FileConfig | null> {
    if (!this.isCliMode()) return null;

    try {
      const response = await fetch(`${this.getApiUrl()}/api/config`);
      if (!response.ok) throw new Error('Failed to fetch config');
      this.config = await response.json();
      return this.config;
    } catch (error) {
      console.error('Failed to fetch CLI config:', error);
      return null;
    }
  }

  /**
   * Load the file specified by the CLI
   */
  async loadFile(): Promise<FileData | null> {
    if (!this.isCliMode()) return null;

    try {
      const response = await fetch(`${this.getApiUrl()}/api/file`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to load file');
      }
      const data = await response.json();
      this.lastSavedContent = data.content;
      return data;
    } catch (error) {
      console.error('Failed to load file:', error);
      throw error;
    }
  }

  /**
   * Save the file content
   */
  async saveFile(content: string): Promise<boolean> {
    if (!this.isCliMode()) return false;
    if (this.config?.readOnly) {
      console.warn('Cannot save: file is opened in read-only mode');
      return false;
    }

    try {
      const response = await fetch(`${this.getApiUrl()}/api/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save file');
      }

      this.lastSavedContent = content;
      return true;
    } catch (error) {
      console.error('Failed to save file:', error);
      return false;
    }
  }

  /**
   * Save with debouncing (auto-save)
   */
  debouncedSave(content: string, delay: number = 1000): void {
    if (content === this.lastSavedContent) return;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.saveFile(content).then((success) => {
        if (success) {
          this.updateTitleSaved();
        }
      });
    }, delay);

    this.updateTitleUnsaved();
  }

  /**
   * Get the filename being edited
   */
  getFileName(): string | null {
    return this.config?.fileName || null;
  }

  /**
   * Check if file is read-only
   */
  isReadOnly(): boolean {
    return this.config?.readOnly || false;
  }

  /**
   * Update document title to show save status
   */
  private updateTitleSaved(): void {
    const fileName = this.getFileName();
    if (fileName) {
      document.title = `${fileName} - Review Room`;
    }
  }

  private updateTitleUnsaved(): void {
    const fileName = this.getFileName();
    if (fileName) {
      document.title = `● ${fileName} - Review Room`;
    }
  }

  /**
   * Set the initial document title
   */
  setInitialTitle(): void {
    const fileName = this.getFileName();
    if (fileName) {
      document.title = `${fileName} - Review Room`;
    } else {
      document.title = 'Review Room';
    }
  }
}

// Export singleton instance
export const fileClient = new FileClient();
