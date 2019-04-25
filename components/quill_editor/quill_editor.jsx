// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import PropTypes from 'prop-types';
import React from 'react';

import Quill from 'quill';
import Delta from 'quill-delta';

import {initializeBlots} from './blots';
import {initializeMatchers} from './matchers';
import * as Utils from './utils';

initializeBlots();

// QuillEditor is a mix between controlled and uncontrolled component.
// (see: https://reactjs.org/blog/2018/06/07/you-probably-dont-need-derived-state.html)
// Controlled because parent (eg, CreatePost) holds the message state (passed through to props.value).
// Uncontrolled, because the Quill object uses its own state (a shadow dom tree).
// QuillEditor transforms the Quill object's internal state into a markdown string, and sends
// that markdown string up to be worked with and stored into the message state (which is then
// passed to QuillEditor's props.value).
// When the parent components change the message state, QuillEditor will transform that
// into the Quill object's state.
// Source of Truth: therefore, the single source of truth is always the parents's message state.
// If the parent's message state changes, QuillEditor's contents will be changed.
export default class QuillEditor extends React.Component {
    static propTypes = {
        id: PropTypes.string,
        className: PropTypes.string.isRequired,
        spellCheck: PropTypes.string,
        placeholder: PropTypes.string,
        onKeyPress: PropTypes.func,
        onKeyDown: PropTypes.func.isRequired,
        style: PropTypes.object,
        value: PropTypes.string.isRequired,
        disabled: PropTypes.bool,
        onChange: PropTypes.func.isRequired,
        onCompositionStart: PropTypes.func.isRequired,
        onCompositionUpdate: PropTypes.func.isRequired,
        onCompositionEnd: PropTypes.func.isRequired,
        onHeightChange: PropTypes.func,

        /**
         * maxLength is optional. If it exists, the input will not allow any more characters typed past the maxLength.
         */
        maxLength: PropTypes.number,

        // TODO: need to implement conditional rendering.
        config: PropTypes.object.isRequired,
        emojiMap: PropTypes.object.isRequired,
    };

    constructor(props) {
        super(props);
        this.quillEl = React.createRef();
        this.state = {
            valueInMarkdown: '',
            prevValue: '',
        };
    }

    componentWillUnmount = () => {
        // prevent memory leaks (wish it was this easy in real life)
        this.editor.off('text-change');
    }

    shouldComponentUpdate = (nextProps, nextState) => {
        // The Quill object never needs to be re-rendered in response to props or state change,
        // at least after its been mounted (in this way it's an uncontrolled component)
        // But it does need to respond to props.value changes from parents -- the parent is
        // the single source of truth (in this way it's a controlled component).
        // That kind of updating the child component /should/ happen in `componentDidUpdate`,
        // but because we never need to render, and we return false, that will never be called.
        // So do that here.

        if (nextState.valueInMarkdown !== this.state.valueInMarkdown) {
            // we're just being notified the component state has changed. No need to do anything.
            return false;
        }

        if (nextProps.value !== this.state.valueInMarkdown) {
            // this prevents a loop from create comment. Not sure why it updates with old props after
            // a typing event.
            if (nextProps.value === this.state.prevValue && this.props.id === 'reply_textbox') {
                return false;
            }

            // we're receiving a new value from our parents.
            this.setState({
                valueInMarkdown: nextProps.value || '',
                prevValue: this.state.valueInMarkdown,
            });

            // TODO: convert the parent's source of truth to Quill's format
            this.editor.setContents([{insert: nextProps.value}]);
        }
        return false;
    }

    // todo: need to implement. Check AutosizeTextEditor
    // get selectionStart() {
    //     return this.forwardedRef.current.getEditorSelection();
    // }
    //
    // set selectionStart(selectionStart) {
    //     this.refs.textarea.selectionStart = selectionStart;
    // }
    //
    // get selectionEnd() {
    //     return this.refs.textarea.selectionEnd;
    // }
    //
    // set selectionEnd(selectionEnd) {
    //     this.refs.textarea.selectionEnd = selectionEnd;
    // }

    receiveScrollingContainerRef = (containerElement) => {
        // now that the wrapper has finished setting up its div, we can create the Quill editor.
        this.editor = new Quill(this.quillEl.current,
            {
                modules: {toolbar: false},
                theme: null,
                placeholder: this.props.placeholder,
                scrollingContainer: containerElement,
            });
        this.editor.on('text-change', this.handleChange);

        initializeMatchers(this.editor);

        // TODO: convert the parent's source of truth to Quill's format
        this.editor.setContents([{insert: this.props.value}]);
    }

    focus = () => {
        if (this.editor) {
            this.editor.focus();
        }
    }

    hasFocus = () => {
        return this.editor.hasFocus();
    }

    blur = () => {
        if (this.editor) {
            this.editor.blur();
        }
    }

    setCaretToEnd = () => {
        this.editor.setSelection(this.editor.getLength());
    }

    // unused params: oldContents, source
    handleChange = (delta, oldContents) => {
        const contents = this.editor.getContents().ops;
        const newValue = Utils.prepareMarkdown(contents);

        if (this.props.maxLength && newValue.length > this.props.maxLength) {
            // The length is calculated based on the markdown representation of the text, not the rendered length.
            // So instead of trying to find where the cursor would be in the rendered version of the text and then
            // deleting, just don't allow inserts after the limit is reached.
            const undoChange = new Delta(delta).invert(oldContents);
            this.editor.updateContents(undoChange);
            return;
        }

        // SuggestionBox.handleChange needs to know the caret and pretext
        let [leafText, localCaret] = this.editor.getLeaf(this.editor.getSelection(true).index);
        leafText = leafText.text || '';

        // Create emojis as they are typed. Text must be at least 3 characters long, to include one letter emoji like :a:
        // TODO: render conditionally based on config settings.
        const minNumOfChars = 3;
        if (localCaret >= minNumOfChars &&
            leafText.length >= minNumOfChars &&
            delta.ops[delta.ops.length - 1].hasOwnProperty('insert') &&
            delta.ops[delta.ops.length - 1].insert === ':') {
            const matched = Utils.detectEmojiOnColon(leafText, localCaret, minNumOfChars, this.props.emojiMap);
            if (matched) {
                this.insertEmojiReplacingLength(matched.name, matched.text.length);

                // these have now changed:
                [leafText, localCaret] = this.editor.getLeaf(this.editor.getSelection(true).index);
                leafText = leafText.text || '';
            }
        }

        // Text must be at least 3 characters long, to include two-character literals, like :), plus the space
        const literalMinNumOfChars = 3;
        if (localCaret >= literalMinNumOfChars &&
            leafText.length >= literalMinNumOfChars &&
            delta.ops[delta.ops.length - 1].hasOwnProperty('insert') &&
            delta.ops[delta.ops.length - 1].insert === ' ') {
            const matched = Utils.detectLiteralEmojiOnSpace(leafText, localCaret, literalMinNumOfChars, this.props.emojiMap);
            if (matched) {
                this.insertEmojiReplacingLength(matched.name, matched.text.length);

                // these have now changed:
                [leafText, localCaret] = this.editor.getLeaf(this.editor.getSelection(true).index);
                leafText = leafText.text || '';
            }
        }

        // we now have this value, so no need to rerender when props.value is changed to this.
        this.setState({
            valueInMarkdown: newValue,
            prevValue: this.state.valueInMarkdown,
        });

        // handled by SuggestionBox.handleChange
        this.props.onChange(newValue, leafText, localCaret);
    };

    handleCompositionUpdate = (e) => {
        const [leaf] = this.editor.getLeaf(this.editor.getSelection(true).index);
        const leafText = leaf.text || '';

        if (this.props.onCompositionUpdate) {
            this.props.onCompositionUpdate(e, leafText);
        }
    }

    addTextAtCaret = (text, matchedPretext, tabOrEnter = false) => {
        let globalCaret = this.editor.getSelection(true).index;

        // remove the \t or \n that quill adds, if any.
        if (tabOrEnter) {
            const removeChar = new Delta().retain(globalCaret - 1).delete(1);
            this.editor.updateContents(removeChar);
            globalCaret -= 1;
        }

        // replace matchedPretext, if any.
        if (matchedPretext) {
            const delta = new Delta().retain(globalCaret - matchedPretext.length).delete(matchedPretext.length);
            this.editor.updateContents(delta);
            globalCaret -= matchedPretext.length;
        }

        this.editor.insertText(globalCaret, text);
        globalCaret += text.length;
        this.editor.setSelection(globalCaret);

        // Following You Aren't Going to Need It (YAGNI), for now we always need to add a space after inserting text.
        // We can allow adding no-space when we need it.
        this.editor.insertText(globalCaret, ' ');

        const newValue = Utils.prepareMarkdown(this.editor.getContents().ops);
        this.setState({
            valueInMarkdown: newValue,
            prevValue: this.state.valueInMarkdown,
        });
        return newValue;
    }

    // called from SuggestionBox or a parent (eg, CreatePost -- through Textbox)
    addEmojiAtCaret = (term, matchedPretext, tabOrEnter) => {
        this.editor.focus();
        const globalCaret = this.editor.getSelection().index;
        let moveCursorExtraSpaces = true;

        // remove the \t or \n that quill adds, if any.
        if (tabOrEnter) {
            const removeChar = new Delta().retain(globalCaret - 1).delete(1);
            this.editor.updateContents(removeChar);
            moveCursorExtraSpaces = false;
        }

        const emojiName = term.slice(1, -1);
        this.insertEmojiReplacingLength(emojiName, matchedPretext.length);

        if (moveCursorExtraSpaces) {
            this.editor.setSelection(this.editor.getSelection().index + 2);
        }

        const newValue = Utils.prepareMarkdown(this.editor.getContents().ops);
        this.setState({
            valueInMarkdown: newValue,
            prevValue: this.state.valueInMarkdown,
        });
        return newValue;
    }

    insertEmojiReplacingLength = (name, length) => {
        const globalCaret = this.editor.getSelection().index;

        // get the emoji Url
        const imageUrl = Utils.getEmojiUrl(name, this.props.emojiMap);
        const style = `background-image: url('${imageUrl}');`;

        const delta = new Delta().retain(globalCaret - length).delete(length).insert({
            emoji: {
                title: `:${name}:`,
                style,
            },
        }).insert(' ');
        this.editor.updateContents(delta);
    };

    replaceText = (text) => {
        this.editor.focus();
        this.editor.setContents([{insert: text}]);
        this.setState({
            valueInMarkdown: text,
            prevValue: this.state.valueInMarkdown,
        });
    }

    // TODO: implement
    recalculateSize = () => {
        //const height = this.quillEl.scrollHeight;
        //const quillElement = this.quillEl;
        //
        //if (height > 0 && height !== this.height) {
        //    const style = getComputedStyle(quillElement);
        //    const borderWidth = parseInt(style.borderTopWidth, 10) + parseInt(style.borderBottomWidth, 10);
        //
        //    // Directly change the height to avoid circular rerenders
        //    quillElement.style.height = String(height + borderWidth) + 'px';
        //
        //    this.height = height;
        //
        //    if (this.props.onHeightChange) {
        //        this.props.onHeightChange(height, parseInt(style.maxHeight, 10));
        //    }
        //}
    };

    render = () => {
        const {
            onKeyPress,
            onKeyDown,
            onCompositionStart,
            onCompositionEnd,

            // TODO: The provided `id` is sometimes hard-coded and used to interface with the
            // component, e.g. `post_textbox`, so it can't be changed. This would ideally be
            // abstracted to avoid passing in an `id` prop at all, but we intentionally maintain
            // the old behaviour to address ABC-213.
            // TODO: might not need `id` since we're passing down a ref... Investigate.
            id,
        } = this.props;

        return (
            <div
                ref={this.quillEl}
                id={id}
                className={this.props.className}
                onKeyPress={onKeyPress}
                onKeyDown={onKeyDown}
                onCompositionStart={onCompositionStart}
                onCompositionUpdate={this.handleCompositionUpdate}
                onCompositionEnd={onCompositionEnd}
            />
        );
    }
}
