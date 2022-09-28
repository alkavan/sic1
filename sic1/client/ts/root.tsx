import { CompilationError } from "sic1asm";
import { Puzzle, puzzles, puzzleCount, puzzleFlatArray } from "sic1-shared";
import { Platform } from "./platform";
import { MessageBox, MessageBoxContent } from "./message-box";
import { Shared } from "./shared";
import { TextButton } from "./text-button";
import { ChartState } from "./chart";
import { Sic1DataManager, UserData } from "./data-manager";
import { LeaderboardEntry, Sic1WebService, StatChanges } from "./service";
import { Sic1Ide } from "./ide";
import { ensureSolutionStatsMailUnread, hasUnreadMail, updateMailListForSolvedCount, updateSessionStats } from "./mail";
import { MailViewer } from "./mail-viewer";
import licenses from "./licenses";
import { Component, ComponentChild, ComponentChildren, createRef } from "preact";
import { PuzzleList } from "./puzzle-list";

// TODO: Consider moving autoStep to state and having a "pause" button instead of "run"

class Sic1UserProfileForm extends Component<{ onCompleted: (name: string, uploadName: boolean) => void }> {
    private inputName = createRef<HTMLInputElement>();
    private inputUploadName = createRef<HTMLInputElement>();

    public submit() {
        this.props.onCompleted(this.inputName.current.value, this.inputUploadName.current.checked);
    }

    public render() {
        const data = Sic1DataManager.getData();

        return <form onSubmit={(event) => {
                event.preventDefault();
                this.submit();
            }}>
                <label>Name: <input
                    ref={this.inputName}
                    autoFocus={true}
                    maxLength={Sic1WebService.userNameMaxLength}
                    // @ts-ignore: Work around Preact #2668
                    defaultValue={data.name || Shared.defaultName}
                    /></label>
                <p><label><input
                    ref={this.inputUploadName} type="checkbox"
                    // @ts-ignore: Work around Preact #2668
                    defaultChecked={(typeof(data.uploadName) === "boolean") ? data.uploadName : true}
                    /> Show my name in public leaderboards (if unchecked, your statistics will be shown without a name)</label></p>
            </form>;
    }
}

interface Sic1LeaderboardState {
    chartState: ChartState;
    data?: LeaderboardEntry[];
}

class Sic1Leaderboard extends Component<{ promise: Promise<LeaderboardEntry[]> }, Sic1LeaderboardState> {
    constructor(props) {
        super(props);
        this.state = { chartState: ChartState.loading };
    }

    public async componentDidMount() {
        try {
            this.setState({
                chartState: ChartState.loaded,
                data: await this.props.promise,
            });
        } catch (error) {
            this.setState({ chartState: ChartState.loadFailed });
        }
    }

    public render() {
        let body: ComponentChildren;
        switch (this.state.chartState) {
            case ChartState.loading:
                body = <td colSpan={2} className="center">(Loading...)</td>;
                break;

            case ChartState.loaded:
                body = this.state.data.map(row =>
                    <tr>
                        <td className={"text" + ((row.name.length > 0) ? "" : " deemphasize")}>{(row.name.length > 0) ? `${row.name} (${Shared.getJobTitleForSolvedCount(row.solved)})` : "(anonymous)"}</td>
                        <td>{row.solved}</td>
                    </tr>);
                break;

            default:
                body = <td colSpan={2} className="center">(Load failed)</td>;
                break;
        }

        return <table>
            <thead><tr><th>Name</th><th>Tasks Completed</th></tr></thead>
            <tbody>{body}</tbody>
        </table>;
    }
}

class ZoomSlider extends Component<{}> {
    private initialZoomPercent: number;

    constructor(props) {
        super(props);

        const fontSize = document.documentElement.style.getPropertyValue("font-size") || "100%";
        this.initialZoomPercent = parseFloat(/^([0-9]+)%$/.exec(fontSize)[1]);
    }

    public render(): ComponentChild {
        return <label>Zoom:
            <input
                type="range"
                min={60}
                max={200}
                step={20}
                // @ts-ignore: Work around Preact #2668
                defaultValue={this.initialZoomPercent}
                onChange={(event) => { document.documentElement.style.setProperty("font-size", `${event.currentTarget.value}%`); } }
                />
        </label>;
    }
}

interface Sic1SoundCheckboxProps {
    position: "left" | "right";
    soundEffects: boolean;
    onSoundEffectsUpdated: (soundEffects: boolean) => void;
}

class Sic1SoundCheckbox extends Component<Sic1SoundCheckboxProps> {
    public render(): ComponentChild {
        const checkbox = <input
            className={this.props.position}
            type="checkbox"
            onChange={(event) => this.props.onSoundEffectsUpdated(event.currentTarget.checked)}
            // @ts-ignore: Work around Preact #2668
            defaultChecked={this.props.soundEffects}
            />;

        if (this.props.position === "left") {
            return <label>{checkbox}Enable sound effects</label>;
        } else {
            return <label>Sound effects: {checkbox}</label>;
        }
    }
}

interface Sic1PresentationSettingsProps {
    soundEffects: boolean;
    onSoundEffectsUpdated: (soundEffects: boolean) => void;
    soundVolume: number;
    onSoundVolumeUpdated: (volume: number) => void;
}

class Sic1PresentationSettings extends Component<Sic1PresentationSettingsProps> {
    public render(): ComponentChild {
        return <>
            <form onSubmit={(event) => event.preventDefault()}>
                <label>Fullscreen: <input
                    className="right"
                    type="checkbox"
                    onChange={(event) => Platform.fullscreen.set(event.currentTarget.checked) }
                    // @ts-ignore: Work around Preact #2668
                    defaultChecked={Platform.fullscreen.get()}
                    /></label>
                <ZoomSlider/>
                <br/>
                <Sic1SoundCheckbox position="right" soundEffects={this.props.soundEffects} onSoundEffectsUpdated={this.props.onSoundEffectsUpdated} />
                <label>Sound effects volume:
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        disabled={false}
                        // @ts-ignore: Work around Preact #2668
                        defaultValue={this.props.soundVolume}
                        onChange={(event) => { this.props.onSoundVolumeUpdated(parseFloat(event.currentTarget.value)) } }
                        />
                </label>
            </form>
        </>;
    }
}

interface Sic1RootPuzzleState {
    puzzle: Puzzle;
    defaultCode: string;
}

interface Sic1RootState extends Sic1RootPuzzleState {
    messageBoxQueue: MessageBoxContent[];
    soundEffects: boolean;
    soundVolume: number;
}

export class Sic1Root extends Component<{}, Sic1RootState> {
    private ide = createRef<Sic1Ide>();
    private userProfileForm = createRef<Sic1UserProfileForm>();
    
    private sounds: { [name: string]: HTMLAudioElement } = {
        completed: new Audio((new URL('../sfx/completed.wav', import.meta.url)).href),
        correct: new Audio((new URL('../sfx/correct.wav', import.meta.url)).href),
        incorrect: new Audio((new URL('../sfx/incorrect.wav', import.meta.url)).href),
    };

    constructor(props) {
        super(props);

        // User data migration
        // Update inbox to reflect current solved count
        updateMailListForSolvedCount();

        // Load previous puzzle, if available
        let puzzle = puzzles[0].list[0];
        const previousPuzzleTitle = Sic1DataManager.getData().currentPuzzle;
        if (previousPuzzleTitle) {
            const previousPuzzle = ([] as Puzzle[]).concat(...puzzles.map(group => group.list)).find(puzzle => puzzle.title === previousPuzzleTitle);
            puzzle = previousPuzzle || puzzle;
        }

        const { defaultCode } = Sic1Root.getStateForPuzzle(puzzle);
        const presentationData = Sic1DataManager.getPresentationData();
        this.state ={
            puzzle,
            defaultCode,
            messageBoxQueue: [],
            soundEffects: presentationData.soundEffects,
            soundVolume: presentationData.soundVolume,
        }
    }

    private static getDefaultCode(puzzle: Puzzle) {
        // Load progress (or fallback to default)
        const puzzleData = Sic1DataManager.getPuzzleData(puzzle.title);
        let code = puzzleData.code;
        if (code === undefined || code === null) {
            if (puzzle.code) {
                code = puzzle.code;
            } else {
                code = `; ${puzzle.description}\n`;
            }
        }
        return code;
    }

    private static getStateForPuzzle(puzzle: Puzzle): Sic1RootPuzzleState {
        return {
            puzzle,
            defaultCode: Sic1Root.getDefaultCode(puzzle),
        };
    }

    private static getJobTitle(data: UserData): string {
        return Shared.getJobTitleForSolvedCount(data.solvedCount);
    }

    private playSound(name: string, volumeOverride?: number): void {
        if (this.state.soundEffects) {
            const sound = this.sounds[name];
            sound.volume = volumeOverride ?? this.state.soundVolume;
            sound.currentTime = 0;
            sound.play();
        }
    }

    private stopSound(name: string): void {
        const sound = this.sounds[name];
        sound.volume = 0;
    }

    private playSoundTest(volume: number): void {
        this.playSound("correct", volume);
    }

    private playSoundCorrect(): void {
        this.playSound("correct");
    }

    private playSoundIncorrect(): void {
        this.stopSound("correct");
        this.playSound("incorrect");
    }

    private playSoundCompleted(): void {
        this.stopSound("correct");
        this.playSound("completed");
    }

    private saveProgress(): void {
        if (this.ide.current) {
            const puzzle = this.state.puzzle;
            let code = this.ide.current.getCode();
            if (code === puzzle.code) {
                code = null;
            }

            const puzzleData = Sic1DataManager.getPuzzleData(puzzle.title);
            if (puzzleData.code !== code) {
                puzzleData.code = code;
                Sic1DataManager.savePuzzleData(puzzle.title);
            }
        }
    }

    private loadPuzzle(puzzle: Puzzle): void {
        // Save progress on previous puzzle
        this.saveProgress();

        // Save as last open puzzle
        const data = Sic1DataManager.getData();
        if (data.currentPuzzle !== puzzle.title) {
            data.currentPuzzle = puzzle.title;
            Sic1DataManager.saveData();
        }

        // Mark new puzzle as viewed
        const puzzleData = Sic1DataManager.getPuzzleData(puzzle.title);
        if (!puzzleData.viewed) {
            puzzleData.viewed = true;
            Sic1DataManager.savePuzzleData(puzzle.title);
        }

        this.setState(Sic1Root.getStateForPuzzle(puzzle));
        if (this.ide.current) {
            this.ide.current.reset(puzzle);
        }

        this.messageBoxClear();
    }

    private puzzleCompleted(cycles: number, bytes: number, programBytes: number[]): void {
        // Mark as solved in persistent state
        const puzzle = this.state.puzzle;
        const puzzleData = Sic1DataManager.getPuzzleData(puzzle.title);
        const data = Sic1DataManager.getData();
        const solvedCountOld = data.solvedCount;
        const cyclesOld = puzzleData.solutionCycles;
        const bytesOld = puzzleData.solutionBytes;

        if (!puzzleData.solved) {
            data.solvedCount = Math.min(puzzleFlatArray.length, data.solvedCount + 1);

            puzzleData.solved = true;
            puzzleData.solutionCycles = cycles;
            puzzleData.solutionBytes = bytes;

            Sic1DataManager.saveData();
            Sic1DataManager.savePuzzleData(puzzle.title);
        } else if (cycles < puzzleData.solutionCycles || bytes < puzzleData.solutionBytes) {
            puzzleData.solutionCycles = Math.min(puzzleData.solutionCycles, cycles);
            puzzleData.solutionBytes = Math.min(puzzleData.solutionBytes, bytes);
            Sic1DataManager.savePuzzleData(puzzle.title);
        }

        // Prepare a list of potential changes
        const statChanges: StatChanges = {
            solvedCount: {
                improved: (solvedCountOld === undefined) || (data.solvedCount > solvedCountOld),
                oldScore: solvedCountOld,
                newScore: data.solvedCount,
            },
            cycles: {
                improved: (cyclesOld === undefined) || (cycles < cyclesOld),
                oldScore: cyclesOld,
                newScore: cycles,
            },
            bytes: {
                improved: (bytesOld === undefined) || (bytes < bytesOld),
                oldScore: bytesOld,
                newScore: bytes,
            },
        }

        // Check for new mail (and add with read=false)
        updateMailListForSolvedCount(false);

        // Force the automated stats mail to be unread
        ensureSolutionStatsMailUnread(puzzle.title);

        // Start uploading solution/stats
        const leaderboardPromises = Platform.service.updateStatsIfNeededAsync(data.userId, puzzle.title, programBytes, statChanges);

        // Update session stats (and any leaderboard update+loading promises) so they'll be shown in the mail viewer
        updateSessionStats(puzzle.title, cycles, bytes, leaderboardPromises);

        this.messageBoxPush(this.createMessageMailViewer());
    }

    /** Gets the title of the next unsolved puzzle, or null if all puzzles have been solved. "Next" meaning the current
     * puzzle if it's unsolved, otherwise the next higher one, wrapping around, if needed. */
    private getNextPuzzle(): Puzzle | null {
        if (!Sic1DataManager.getPuzzleData(this.state.puzzle.title).solved) {
            return this.state.puzzle;
        }

        const currentPuzzleTitle = this.state.puzzle.title;
        const currentPuzzleIndex = puzzleFlatArray.findIndex(p => p.title === currentPuzzleTitle);
        if (currentPuzzleIndex >= 0) {
            let index = currentPuzzleIndex;
            do {
                index = (index + 1) % puzzleCount;
            } while (index !== currentPuzzleIndex && Sic1DataManager.getPuzzleData(puzzleFlatArray[index].title).solved);
            if (index !== currentPuzzleIndex) {
                return puzzleFlatArray[index];
            }
        }
        return null;
    }

    private toggleMenu() {
        if (this.state.messageBoxQueue.length > 0) {
            if (this.state.messageBoxQueue[0].modal !== true) {
                this.messageBoxPop();
            }
        } else {
            this.messageBoxPush(this.createMessageMenu());
        }
    }

    private keyUpHandler = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            if (this.state.messageBoxQueue.length > 0) {
                if (this.state.messageBoxQueue[0].modal !== true) {
                    this.messageBoxPop();
                }
            } else if (this.ide.current && this.ide.current.isExecuting()) {
                this.ide.current.pause();
            } else if (this.ide.current && this.ide.current.hasStarted()) {
                this.ide.current.stop();
            } else {
                this.messageBoxPush(this.createMessageMenu());
            }
        } else if (event.altKey && event.key === "Enter" || (Platform.app && (event.key === "F11" || event.key === "F4"))) {
            // Fullscreen hotkeys: Alt+Enter (on all platforms), and also F4/F11 for non-web versions
            Platform.fullscreen.set(!Platform.fullscreen.get());
        }
    }

    private updateUserProfile(name: string, uploadName: boolean | undefined, callback: () => void) {
        const data = Sic1DataManager.getData();
        data.name = name;
        if (uploadName !== undefined) {
            data.uploadName = uploadName;
        }

        data.introCompleted = true;
        Sic1DataManager.saveData();

        // No need to wait for completion
        Platform.service.updateUserProfileAsync(data.userId, uploadName ? name : "").catch(() => {});

        callback();
    }

    private updateSoundEffects(enabled: boolean): void {
        const presentation = Sic1DataManager.getPresentationData();
        if (presentation.soundEffects !== enabled) {
            presentation.soundEffects = enabled;
            Sic1DataManager.savePresentationData();
            this.setState({ soundEffects: presentation.soundEffects });
        }
    }

    private updateSoundVolume(volume: number): void {
        const presentation = Sic1DataManager.getPresentationData();
        if (presentation.soundVolume !== volume) {
            presentation.soundVolume = volume;
            Sic1DataManager.savePresentationData();
            this.setState({ soundVolume: volume });
            this.playSoundTest(volume);
        }
    }

    private createMessageIntro(): MessageBoxContent {
        return {
            title: "Job Application",
            modal: true,
            body: <>
                <h3>JOB DESCRIPTION:</h3>
                <p>SIC Systems is looking for experienced programmers to join our team!</p>
                <p>As an engineer at SIC Systems, you'll produce highly efficient programs for our flagship product: the Single Instruction Computer Mark 1 (SIC-1). You will be competing against other engineers to produce the fastest and smallest programs.</p>
                <p>This is a full-time salaried role. The ideal candidate for this job will have a PhD and 15 - 20 years (or more) of industry experience, along with a relentless attention to detail and exemplary interpersonal skills. Scheduling flexibility is a plus, as we push toward our worldwide launch.</p>
                <h3>ABOUT SIC SYSTEMS:</h3>
                <p>SIC Systems is the world leader in single-instruction computing. Our mission is to simplify computation, and thus simplify the world. We are innovative, trustworthy, and ethical.</p>
                {
                    Platform.disableUserNameUpload
                    ? <>
                        <p>Click the button below to submit your job application:</p>
                        <br/><button onClick={() => this.updateUserProfile("", undefined, () => this.messageBoxReplace(this.createMessageMailViewer()))}>Apply for the Job</button>
                    </>
                    : <>
                        <h3>JOB APPLICATION:</h3>
                        <p><Sic1UserProfileForm ref={this.userProfileForm} onCompleted={(name, uploadName) => this.updateUserProfile(name, uploadName, () => this.messageBoxReplace(this.createMessageMailViewer()))} /></p>
                        <p><Sic1SoundCheckbox position="left" soundEffects={this.state.soundEffects} onSoundEffectsUpdated={(enabled) => this.updateSoundEffects(enabled)} /></p>
                        <p>After completing the form above, click the button below to submit your job application:</p>
                        <br/><button onClick={() => this.userProfileForm.current.submit()}>Apply for the Job</button>
                    </>
                }
            </>
        };
    }

    private createMessageUserProfileEdit(): MessageBoxContent {
        return {
            title: "User Profile",
            body: <>
                <p>Update your user profile as needed:</p>
                <p><Sic1UserProfileForm ref={this.userProfileForm} onCompleted={(name, uploadName) => this.updateUserProfile(name, uploadName, () => this.messageBoxPop())} /></p>
                <br/>
                <button onClick={() => this.userProfileForm.current.submit()}>Save Changes</button>
                <button onClick={() => this.messageBoxPop()}>Cancel</button>
            </>,
        };
    }

    private createMessageOptions(): MessageBoxContent {
        return {
            title: "Options",
            body: <>
                {Platform.service.getLeaderboardAsync ? <button onClick={() => this.messageBoxPush(this.createMessageLeaderboard())}>Leaderboard</button> : null }
                {Platform.disableUserNameUpload ? null : <button onClick={() => this.messageBoxPush(this.createMessageUserProfileEdit())}>User Settings</button>}
                <button onClick={() => this.messageBoxPush(this.createMessagePresentationSettings())}>Presentation Settings</button>
                <br/><button onClick={() => this.messageBoxPush(this.createMessageCredits())}>Credits</button>
            </>,
        };
    }

    private createMessageMenu(): MessageBoxContent {
        return {
            title: "Main Menu",
            body: <>
                <button onClick={() => this.messageBoxReplace(this.createMessagePuzzleList())}>Program Inventory</button>
                <button onClick={() => this.messageBoxReplace(this.createMessageMailViewer())}>Electronic Mail</button>
                <br/><button onClick={() => {this.messageBoxPush(this.createMessageOptions())}}>Options</button>
                {Platform.app ? <><br/><button onClick={() => window.close()}>Exit SIC-1</button></> : null}
            </>,
        };
    }

    private createMessagePresentationSettings(): MessageBoxContent {
        return {
            title: "Presentation",
            body: <Sic1PresentationSettings
                soundEffects={this.state.soundEffects}
                onSoundEffectsUpdated={(enabled) => this.updateSoundEffects(enabled)}
                soundVolume={this.state.soundVolume}
                onSoundVolumeUpdated={(volume) => this.updateSoundVolume(volume)}
                />,
        };
    }

    private createMessageLicenses(): MessageBoxContent {
        return {
            title: "Licenses",
            body: <>
                <h2>Third Party Licenses</h2>
                <pre className="licenses">{licenses}</pre>
            </>,
        };
    }

    private createMessageCredits(): MessageBoxContent {
        function Credit(props: { title: string, entries: { link: string, name: string }[] }) {
            return <>
                <h3 className="credit">{props.title}</h3>
                {props.entries.map(({ link, name }) => <p className="credit"><a href={link} target="_blank">{name}</a></p>)}
            </>;
        }

        return {
            title: "Credits",
            body: <>
                <Credit title="Game Design, Development" entries={[{ link: "https://www.antipatterngames.com/", name: "Anti-Pattern Games" }]} />
                <Credit title="Inspiration" entries={[{ link: "https://www.zachtronics.com/", name: "Zachtronics (originators of the \"zachlike\" genre)" }]} />
                <p>To view third party licenses, <TextButton text="click here" onClick={() => this.messageBoxPush(this.createMessageLicenses())} />.</p>
            </>,
        };
    }

    private createMessageMailViewer(): MessageBoxContent {
        const nextPuzzle = this.getNextPuzzle();
        return {
            title: "Electronic Mail",
            body: <MailViewer
                mails={Sic1DataManager.getData().inbox ?? []}
                onLoadPuzzleRequested={(puzzle: Puzzle) => this.loadPuzzle(puzzle)}
                onClearMessageBoxRequested={() => this.messageBoxClear()}
                onNextPuzzleRequested={nextPuzzle ? () => this.messageBoxReplace(this.createMessagePuzzleList(nextPuzzle.title)) : null}
            />,
        };
    }

    private createMessageLeaderboard(): MessageBoxContent {
        const promise = Platform.service.getLeaderboardAsync();
        return {
            title: "Leaderboard",
            body: <>
                <p>Here are the current top employees of SIC Systems' engineering department:</p>
                <Sic1Leaderboard promise={promise} />
            </>,
        };
    }

    private createMessageCompilationError(error: CompilationError): MessageBoxContent {
        return {
            title: "Compilation Error",
            body: <>
                <h2>Compilation Error!</h2>
                <p>{error.message}</p>
                {
                    error.context
                    ?
                        <>
                            <p>On line {error.context.sourceLineNumber}:</p>
                            <p>{error.context.sourceLine}</p>
                        </>
                    : null
                }
            </>,
        };
    }

    private createMessageHalt(): MessageBoxContent {
        return {
            title: "Program Halted",
            body: <>
                <h2>Program Halted</h2>
                <p>The program halted itself by branching to "@HALT" (address 255).</p>
                <p>All of your assigned tasks require the program to repeat indefinitely, so this is an error that must be corrected.</p>
            </>,
        }
    }

    private start() {
        const data = Sic1DataManager.getData();
        if (data.introCompleted) {
            this.messageBoxPush(this.createMessagePuzzleList("userStats"));
        } else {
            this.messageBoxPush(this.createMessageIntro());
        }
    }

    private createMessagePuzzleList(puzzleTitleOrUserStats?: "userStats" | string): MessageBoxContent {
        return {
            title: "Program Inventory",
            body: <PuzzleList
                initialPuzzleTitle={puzzleTitleOrUserStats === "userStats" ? undefined : (puzzleTitleOrUserStats ? puzzleTitleOrUserStats : this.state.puzzle.title)}
                onLoadPuzzleRequested={(puzzle) => this.loadPuzzle(puzzle)}
                hasUnreadMessages={hasUnreadMail()}
                onOpenMailViewerRequested={() => this.messageBoxReplace(this.createMessageMailViewer())}
                currentPuzzleIsSolved={Sic1DataManager.getPuzzleData(this.state.puzzle.title).solved}
                onClearMessageBoxRequested={() => this.messageBoxClear()}
                nextPuzzle={this.getNextPuzzle()}
            />
        };
    }

    private messageBoxReplace(messageBoxContent: MessageBoxContent) {
        this.setState(state => ({ messageBoxQueue: [messageBoxContent, ...state.messageBoxQueue.slice(1)] }));
    }

    private messageBoxPush(messageBoxContent: MessageBoxContent)  {
        this.setState(state => ({ messageBoxQueue: [messageBoxContent, ...state.messageBoxQueue] }));
    }

    private messageBoxClear() {
        this.setState(state => ({ messageBoxQueue: [] }));
    }

    private messageBoxPop() {
        this.setState(state => ({ messageBoxQueue: state.messageBoxQueue.slice(1) }));
    }

    public componentDidMount() {
        window.addEventListener("keyup", this.keyUpHandler);
        Platform.onClosing = () => this.saveProgress();
        this.start();
    }

    public componentWillUnmount() {
        window.removeEventListener("keyup", this.keyUpHandler);
        Platform.onClosing = undefined;
    }

    public render() {
        const messageBoxContent = this.state.messageBoxQueue[0];
        return <>
            <Sic1Ide
                ref={this.ide}
                puzzle={this.state.puzzle}
                defaultCode={this.state.defaultCode}

                onCompilationError={(error) => {
                    this.playSoundIncorrect();
                    this.messageBoxPush(this.createMessageCompilationError(error));
                }}
                onHalt={() => {
                    this.playSoundIncorrect();
                    this.messageBoxPush(this.createMessageHalt());
                }}
                onMenuRequested={() => this.toggleMenu() }
                onPuzzleCompleted={(cycles, bytes, programBytes) => {
                    this.playSoundCompleted();
                    this.puzzleCompleted(cycles, bytes, programBytes);
                }}
                onSaveRequested={() => this.saveProgress()}

                onOutputCorrect={() => this.playSoundCorrect()}
                onOutputIncorrect={() => this.playSoundIncorrect()}
                />
            {
                messageBoxContent
                ? <MessageBox
                    {...messageBoxContent}
                    onDismissed={() => this.messageBoxPop()}
                    />
                : null
            }
        </>;
    }
}
