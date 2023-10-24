import TypeScriptFileCompilerBase from './compiler-base';
import TypescriptConfiguration, {
    TypescriptConfigurationBase,
} from '../../../../configuration/typescript-configuration';
import { TypeScriptCompilerOptions } from '../../../../configuration/interfaces';
import { OptionalCompilerArguments } from '../../../interfaces';

export default class TypeScriptTestFileCompiler extends TypeScriptFileCompilerBase {
    public constructor (compilerOptions?: TypeScriptCompilerOptions, { baseUrl, esm }: OptionalCompilerArguments = {}) {
        super({ baseUrl, esm });

        // NOTE: At present, it's necessary create an instance TypeScriptTestFileCompiler
        // to collect a list of supported test file extensions.
        // So all compilers creates 2 times: first time - for collecting all supported file extensions,
        // second one - for compiling tests.
        // In future, need to rewrite 'getSupportedExtension' method as static.

        const configPath = compilerOptions && compilerOptions.configPath || null;

        this._customCompilerOptions = compilerOptions && compilerOptions.options;
        this._tsConfig              = new TypescriptConfiguration(configPath, esm);
        this._compilerPath          = TypeScriptTestFileCompiler._getCompilerPath(compilerOptions);
    }

    private static _getCompilerPath (compilerOptions?: TypeScriptCompilerOptions): string {
        let compilerPath = compilerOptions && compilerOptions.customCompilerModulePath;

        if (!compilerPath || compilerPath === DEFAULT_TYPESCRIPT_COMPILER_PATH)
            return DEFAULT_TYPESCRIPT_COMPILER_PATH;

        // NOTE: if the relative path to custom TypeScript compiler module is specified
        // then we will resolve the path from the root of the 'testcafe' module
        if (isRelative(compilerPath)) {
            const testcafeRootFolder = path.resolve(__dirname, '../../../../../');

            compilerPath = path.resolve(testcafeRootFolder, compilerPath);
        }

        return compilerPath;
    }

    private _loadTypeScriptCompiler (): TypeScriptInstance {
        try {
            return require(this._compilerPath);
        }
        catch (err: any) {
            throw new GeneralError(RUNTIME_ERRORS.typeScriptCompilerLoadingError, err.message);
        }
    }

    private static _normalizeFilename (filename: string): string {
        filename = path.resolve(filename);

        if (OS.win)
            filename = filename.toLowerCase();

        return filename;
    }

    private static _getTSDefsPath (): string {
        return TypeScriptTestFileCompiler._normalizeFilename(path.resolve(__dirname, '../../../../../ts-defs/index.d.ts'));
    }

    private _reportErrors (diagnostics: Readonly<TypeScript.Diagnostic[]>): void {
        // NOTE: lazy load the compiler
        const ts: TypeScriptInstance = this._loadTypeScriptCompiler();
        let errMsg = 'TypeScript compilation failed.\n';

        diagnostics.forEach(d => {
            const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
            const file    = d.file;

            if (file && d.start !== void 0) {
                const { line, character } = file.getLineAndCharacterOfPosition(d.start);

                errMsg += `${file.fileName} (${line + 1}, ${character + 1}): `;
            }

            errMsg += `${message}\n`;
        });

        throw new Error(errMsg);
    }

    public _compileCodeForTestFiles (testFilesInfo: TestFileInfo[]): Promise<string[]> {
        return this._tsConfig.init(this._customCompilerOptions)
            .then(() => {
                return super._compileCodeForTestFiles(testFilesInfo);
            });
    }

    private _compileFilesToCache (ts: TypeScriptInstance, filenames: string[]): void {
        const opts = this._tsConfig.getOptions() as Dictionary<CompilerOptionsValue>;

        filenames = filenames.map(name => TypeScriptTestFileCompiler._normalizeFilename(name));

        const program = ts.createProgram([TypeScriptTestFileCompiler.tsDefsPath, ...filenames], opts);

        DEBUG_LOGGER('version: %s', ts.version);
        DEBUG_LOGGER('options: %O', opts);

        program.getSourceFiles().forEach(sourceFile => {
            // @ts-ignore A hack to allow import globally installed TestCafe in tests
            sourceFile.renamedDependencies = RENAMED_DEPENDENCIES_MAP;
        });

        const diagnostics = ts.getPreEmitDiagnostics(program);

        if (diagnostics.length)
            this._reportErrors(diagnostics);

        // NOTE: The first argument of emit() is a source file to be compiled. If it's undefined, all files in
        // <program> will be compiled. <program> contains a file specified in createProgram() plus all its dependencies.
        // This mode is much faster than compiling files one-by-one, and it is used in the tsc CLI compiler.
        program.emit(void 0, (outputName, result, writeBOM, onError, sources) => {
            if (!sources)
                return;

            const sourcePath = TypeScriptTestFileCompiler._normalizeFilename(sources[0].fileName);

            this.cache[sourcePath] = result;
        }, void 0, void 0, {
            before: this._getTypescriptTransformers(),
        });
    }

    private _getTypescriptTransformers (): TransformerFactory<SourceFile>[] {
        const transformers: TransformerFactory<SourceFile>[] = [testcafeImportPathReplacer(this.esm)];

        if (this.esm)
            transformers.push(disableV8OptimizationCodeAppender());

        return transformers;
    }

    public _precompileCode (testFilesInfo: TestFileInfo[]): string[] {
        DEBUG_LOGGER('path: "%s"', this._compilerPath);

        // NOTE: lazy load the compiler
        const ts: TypeScriptInstance = this._loadTypeScriptCompiler();
        const filenames              = testFilesInfo.map(({ filename }) => filename);
        const normalizedFilenames    = filenames.map(filename => TypeScriptTestFileCompiler._normalizeFilename(filename));
        const normalizedFilenamesMap = zipObject(normalizedFilenames, filenames);

        const uncachedFiles = normalizedFilenames
            .filter(filename => filename !== TypeScriptTestFileCompiler.tsDefsPath && !this.cache[filename])
            .map(filename => normalizedFilenamesMap[filename]);

        if (uncachedFiles.length)
            this._compileFilesToCache(ts, uncachedFiles);

        return normalizedFilenames.map(filename => this.cache[filename]);
    }

    public _getRequireCompilers (): RequireCompilers {
        const requireCompilers: RequireCompilers = {
            [Extensions.ts]:  (code, filename) => this._compileCode(code, filename),
            [Extensions.tsx]: (code, filename) => this._compileCode(code, filename),
            [Extensions.js]:  (code, filename) => ESNextTestFileCompiler.prototype._compileCode.call(this, code, filename),
            [Extensions.cjs]: (code, filename) => ESNextTestFileCompiler.prototype._compileCode.call(this, code, filename),
            [Extensions.jsx]: (code, filename) => ESNextTestFileCompiler.prototype._compileCode.call(this, code, filename),
        };

        if (this.esm)
            requireCompilers[Extensions.mjs] = (code, filename) => ESNextTestFileCompiler.prototype._compileCode.call(this, code, filename);

        return requireCompilers;
    }

    public get canPrecompile (): boolean {
        return true;
    }

    public get canCompileInEsm (): boolean {
        return true;
    }

    public getSupportedExtension (): string[] {
        return [Extensions.ts, Extensions.tsx];
    }

    async compileConfiguration (filename: string) : Promise<object | null> {
        let compiledConfigurationModule = null;

        const [compiledCode] = await this.precompile([{ code: '', filename }]);

        if (compiledCode) {
            this._setupRequireHook({ });

            compiledConfigurationModule = await this._runCompiledCode({}, compiledCode, filename);
            this._removeRequireHook();

            return compiledConfigurationModule.exports;
        }

        return null;
    }
}
