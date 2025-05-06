// Import from the core script
import {
    eventSource,
    event_types,
    messageFormatting,
    chat,
    clearChat,
    doNewChat,
    openCharacterChat,
    renameChat,
    // addOneMessage, // Not directly imported, use context.addOneMessage
} from '../../../../script.js';

// Import from the extension helper script
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced, // Ensure this is the correct import for saving chat metadata specifically
    // If saveMetadataDebounced is for global settings, and you need to save chat-specific metadata,
    // you might need context.saveChat() or context.saveMetadata() from getContext()
} from '../../../extensions.js';

// Import from the Popup utility script
import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

// Import for group chats
import { openGroupChat } from "../../../group-chats.js";

// Import from the general utility script
import {
    uuidv4,
    timestampToMoment,
    waitUntilCondition,
} from '../../../utils.js';


// Define plugin folder name (important for consistency)
const pluginName = 'star'; // 保持文件夹名称一致

// Initialize plugin settings if they don't exist
if (!extension_settings[pluginName]) {
    extension_settings[pluginName] = {};
}

// --- html2canvas loader ---
function loadHtml2Canvas() {
    return new Promise((resolve, reject) => {
        if (typeof html2canvas !== 'undefined') {
            console.log(`${pluginName}: html2canvas already loaded.`);
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'; // CDN link
        script.onload = () => {
            console.log(`${pluginName}: html2canvas loaded successfully from CDN.`);
            resolve();
        };
        script.onerror = () => {
            console.error(`${pluginName}: Failed to load html2canvas from CDN.`);
            reject(new Error('Failed to load html2canvas'));
        };
        document.head.appendChild(script);
    });
}


// --- 新增：预览状态管理 ---
const previewState = {
    isActive: false,
    originalContext: null, // { characterId: string|null, groupId: string|null, chatId: string }
    previewChatId: null,   // 预览聊天的 ID
};
const returnButtonId = 'favorites-return-button'; // 返回按钮的 ID

// Define HTML for the favorite toggle icon
const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon" title="收藏/取消收藏">
        <i class="fa-regular fa-star"></i>
    </div>
`;

// Store reference to the favorites popup
let favoritesPopup = null;
// Current pagination state
let currentPage = 1;
const itemsPerPage = 5;

/**
 * Ensures the favorites array exists in the current chat metadata accessed via getContext()
 * @returns {object | null} The chat metadata object if available and favorites array is ensured, null otherwise.
 */
function ensureFavoritesArrayExists() {
    let context;
    try {
        context = getContext();
        if (!context || !context.chatMetadata) {
            console.error(`${pluginName}: ensureFavoritesArrayExists - context or context.chatMetadata is not available!`);
            return null;
        }
    } catch (e) {
        console.error(`${pluginName}: ensureFavoritesArrayExists - Error calling getContext():`, e);
        return null;
    }
    const chatMetadata = context.chatMetadata;
    if (!Array.isArray(chatMetadata.favorites)) {
        console.log(`${pluginName}: Initializing chatMetadata.favorites array.`);
        chatMetadata.favorites = [];
    }
    return chatMetadata;
}


/**
 * Adds a favorite item to the current chat metadata
 * @param {Object} messageInfo Information about the message being favorited
 */
function addFavorite(messageInfo) {
    console.log(`${pluginName}: addFavorite 函数开始执行，接收到的 messageInfo:`, messageInfo);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata) {
         console.error(`${pluginName}: addFavorite - 获取 chatMetadata 失败，退出`);
         return;
    }
    const item = {
        id: uuidv4(),
        messageId: messageInfo.messageId,
        sender: messageInfo.sender,
        role: messageInfo.role,
        note: ''
    };
    if (!Array.isArray(chatMetadata.favorites)) {
        console.error(`${pluginName}: addFavorite - chatMetadata.favorites 不是数组，无法添加！`);
        return;
    }
    console.log(`${pluginName}: 添加前 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
    chatMetadata.favorites.push(item);
    console.log(`${pluginName}: 添加后 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
    console.log(`${pluginName}: 即将调用 saveMetadataDebounced (或 context.saveMetadata) 来保存更改...`);
    // SillyTavern's core saveMetadataDebounced is usually for global settings.
    // For chat-specific metadata, context.saveMetadata() or context.updateChatMetadata() might be more appropriate.
    // Let's assume `saveMetadataDebounced` from extensions.js is intended for plugin's own global settings,
    // and for chat-specific metadata, we should use the context's methods.
    const context = getContext();
    if (context && context.saveMetadata) { // Or context.updateChatMetadata if that's the intended API
        context.saveMetadata(); // Or context.updateChatMetadata(chatMetadata);
        console.log(`${pluginName}: Called context.saveMetadata()`);
    } else {
        // Fallback or if saveMetadataDebounced from extensions.js handles this.
        saveMetadataDebounced(); // This might be for the plugin's own settings in extension_settings
        console.log(`${pluginName}: Called (imported) saveMetadataDebounced() as fallback/default.`);
    }
    console.log(`${pluginName}: Added favorite:`, item);
    if (favoritesPopup && favoritesPopup.dlg && favoritesPopup.dlg.hasAttribute('open')) {
        updateFavoritesPopup();
    }
}

/**
 * Removes a favorite by its ID
 * @param {string} favoriteId The ID of the favorite to remove
 * @returns {boolean} True if successful, false otherwise
 */
function removeFavoriteById(favoriteId) {
    console.log(`${pluginName}: removeFavoriteById - 尝试删除 ID: ${favoriteId}`);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
        console.warn(`${pluginName}: removeFavoriteById - chatMetadata 无效或 favorites 数组为空`);
        return false;
    }
    const indexToRemove = chatMetadata.favorites.findIndex(fav => fav.id === favoriteId);
    if (indexToRemove !== -1) {
        console.log(`${pluginName}: 删除前 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
        chatMetadata.favorites.splice(indexToRemove, 1);
        console.log(`${pluginName}: 删除后 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
        const context = getContext();
        if (context && context.saveMetadata) {
            context.saveMetadata();
        } else {
            saveMetadataDebounced();
        }
        console.log(`${pluginName}: Favorite removed: ${favoriteId}`);
        return true;
    }
    console.warn(`${pluginName}: Favorite with id ${favoriteId} not found.`);
    return false;
}

/**
 * Removes a favorite by the message ID it references
 * @param {string} messageId The message ID (from mesid attribute)
 * @returns {boolean} True if successful, false otherwise
 */
function removeFavoriteByMessageId(messageId) {
    console.log(`${pluginName}: removeFavoriteByMessageId - 尝试删除 messageId: ${messageId}`);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
         console.warn(`${pluginName}: removeFavoriteByMessageId - chatMetadata 无效或 favorites 数组为空`);
         return false;
    }
    const favItem = chatMetadata.favorites.find(fav => fav.messageId === messageId);
    if (favItem) {
        return removeFavoriteById(favItem.id);
    }
    console.warn(`${pluginName}: Favorite for messageId ${messageId} not found.`);
    return false;
}

/**
 * Updates the note for a favorite item
 * @param {string} favoriteId The ID of the favorite
 * @param {string} note The new note text
 */
function updateFavoriteNote(favoriteId, note) {
    console.log(`${pluginName}: updateFavoriteNote - 尝试更新 ID: ${favoriteId} 的备注`);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
         console.warn(`${pluginName}: updateFavoriteNote - chatMetadata 无效或 收藏夹为空`);
         return;
    }
    const favorite = chatMetadata.favorites.find(fav => fav.id === favoriteId);
    if (favorite) {
        favorite.note = note;
        const context = getContext();
        if (context && context.saveMetadata) {
            context.saveMetadata();
        } else {
            saveMetadataDebounced();
        }
        console.log(`${pluginName}: Updated note for favorite ${favoriteId}`);
    } else {
        console.warn(`${pluginName}: updateFavoriteNote - Favorite with id ${favoriteId} not found.`);
    }
}

/**
 * Handles the toggle of favorite status when clicking the star icon
 * @param {Event} event The click event
 */
function handleFavoriteToggle(event) {
    console.log(`${pluginName}: handleFavoriteToggle - 开始执行`);
    const target = $(event.target).closest('.favorite-toggle-icon');
    if (!target.length) {
        console.log(`${pluginName}: handleFavoriteToggle - 退出：未找到 .favorite-toggle-icon`);
        return;
    }
    const messageElement = target.closest('.mes');
    if (!messageElement || !messageElement.length) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：无法找到父级 .mes 元素`);
        return;
    }
    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：未找到 mesid 属性`);
        return;
    }
    const messageIndex = parseInt(messageIdString, 10);
    if (isNaN(messageIndex)) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：mesid 解析为 NaN: ${messageIdString}`);
        return;
    }
    console.log(`${pluginName}: handleFavoriteToggle - 获取 context 和消息对象 (索引: ${messageIndex})`);
    let context;
    try {
        context = getContext();
        if (!context || !context.chat) {
            console.error(`${pluginName}: handleFavoriteToggle - 退出：getContext() 返回无效或缺少 chat 属性`);
            return;
        }
    } catch (e) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：调用 getContext() 时出错:`, e);
        return;
    }
    const message = context.chat[messageIndex];
    if (!message) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：在索引 ${messageIndex} 未找到消息对象 (来自 mesid ${messageIdString})`);
        return;
    }
    console.log(`${pluginName}: handleFavoriteToggle - 成功获取消息对象:`, message);
    const iconElement = target.find('i');
    if (!iconElement || !iconElement.length) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：在 .favorite-toggle-icon 内未找到 i 元素`);
        return;
    }
    const isCurrentlyFavorited = iconElement.hasClass('fa-solid');
    console.log(`${pluginName}: handleFavoriteToggle - 更新 UI，当前状态 (isFavorited): ${isCurrentlyFavorited}`);
    if (isCurrentlyFavorited) {
        iconElement.removeClass('fa-solid').addClass('fa-regular');
        console.log(`${pluginName}: handleFavoriteToggle - UI 更新为：取消收藏 (regular icon)`);
    } else {
        iconElement.removeClass('fa-regular').addClass('fa-solid');
        console.log(`${pluginName}: handleFavoriteToggle - UI 更新为：收藏 (solid icon)`);
    }
    if (!isCurrentlyFavorited) {
        console.log(`${pluginName}: handleFavoriteToggle - 准备调用 addFavorite`);
        const messageInfo = {
            messageId: messageIdString,
            sender: message.name,
            role: message.is_user ? 'user' : 'character',
        };
        console.log(`${pluginName}: handleFavoriteToggle - addFavorite 参数:`, messageInfo);
        try {
            addFavorite(messageInfo);
            console.log(`${pluginName}: handleFavoriteToggle - addFavorite 调用完成`);
        } catch (e) {
             console.error(`${pluginName}: handleFavoriteToggle - 调用 addFavorite 时出错:`, e);
        }
    } else {
        console.log(`${pluginName}: handleFavoriteToggle - 准备调用 removeFavoriteByMessageId`);
        console.log(`${pluginName}: handleFavoriteToggle - removeFavoriteByMessageId 参数: ${messageIdString}`);
        try {
            removeFavoriteByMessageId(messageIdString);
            console.log(`${pluginName}: handleFavoriteToggle - removeFavoriteByMessageId 调用完成`);
        } catch (e) {
             console.error(`${pluginName}: handleFavoriteToggle - 调用 removeFavoriteByMessageId 时出错:`, e);
        }
    }
    console.log(`${pluginName}: handleFavoriteToggle - 执行完毕`);
}

/**
 * Adds favorite toggle icons to all messages in the chat that don't have one
 */
function addFavoriteIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const extraButtonsContainer = messageElement.find('.extraMesButtons');
        if (extraButtonsContainer.length && !extraButtonsContainer.find('.favorite-toggle-icon').length) {
            extraButtonsContainer.append(messageButtonHtml);
        }
    });
}

/**
 * Updates all favorite icons in the current view to reflect current state
 */
function refreshFavoriteIconsInView() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) {
        console.warn(`${pluginName}: refreshFavoriteIconsInView - 无法获取有效的 chatMetadata 或 favorites 数组`);
        $('#chat').find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
        return;
    }
    addFavoriteIconsToMessages(); // 确保结构存在
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const messageId = messageElement.attr('mesid');
        if (messageId) {
            const isFavorited = chatMetadata.favorites.some(fav => fav.messageId === messageId);
            const iconElement = messageElement.find('.favorite-toggle-icon i');
            if (iconElement.length) {
                if (isFavorited) {
                    iconElement.removeClass('fa-regular').addClass('fa-solid');
                } else {
                    iconElement.removeClass('fa-solid').addClass('fa-regular');
                }
            }
        }
    });
}

/**
 * Renders a single favorite item for the popup
 * @param {Object} favItem The favorite item to render
 * @param {number} index Index of the item (used for pagination, relative to sorted array)
 * @returns {string} HTML string for the favorite item
 */
function renderFavoriteItem(favItem, index) {
    if (!favItem) return '';
    const context = getContext();
    const messageIndex = parseInt(favItem.messageId, 10);
    let message = null;
    let previewText = '';
    let deletedClass = '';
    let sendDateString = '';

    if (!isNaN(messageIndex) && context.chat && context.chat[messageIndex]) {
         message = context.chat[messageIndex];
    }

    if (message) {
        if (message.send_date) {
            sendDateString = message.send_date; // Keep as is, or format with timestampToMoment if preferred
        } else {
            sendDateString = '[时间未知]';
        }

        if (message.mes) {
            previewText = message.mes;
            try {
                 // Use context.messageFormatting for consistency with SillyTavern's rendering
                 previewText = context.messageFormatting(previewText, favItem.sender, false,
                                                favItem.role === 'user', favItem.messageId, {}, false);
            } catch (e) {
                 console.error(`${pluginName}: Error formatting message preview:`, e);
                 previewText = message.mes; // Fallback to raw message
            }
        } else {
            previewText = '[消息内容为空]';
        }

    } else {
        previewText = '[消息内容不可用或已删除]';
        sendDateString = '[时间不可用]';
        deletedClass = 'deleted';
    }

    const formattedMesid = `#${favItem.messageId}`;

    return `
        <div class="favorite-item" data-fav-id="${favItem.id}" data-msg-id="${favItem.messageId}" data-index="${index}">
            <div class="fav-header-info">
                <div class="fav-send-date">
                    ${sendDateString}
                    <span class="fav-mesid" title="原始消息索引 (mesid)">${formattedMesid}</span>
                </div>
                <div class="fav-meta">${favItem.sender}</div>
            </div>
            <div class="fav-note" style="${favItem.note ? '' : 'display:none;'}">${favItem.note || ''}</div>
            <div class="fav-preview ${deletedClass}">${previewText}</div>
            <div class="fav-actions">
                <i class="fa-solid fa-camera favorite-screenshot-icon" title="截图此收藏"></i>
                <i class="fa-solid fa-pencil" title="编辑备注"></i>
                <i class="fa-solid fa-trash" title="删除收藏"></i>
            </div>
        </div>
    `;
}


/**
 * Handles screenshotting a favorite item's preview content.
 * @param {string} favId The ID of the favorite item.
 * @param {HTMLElement} favoriteItemElement The DOM element of the favorite item in the popup.
 */
async function handleScreenshotFavorite(favId, favoriteItemElement) {
    console.log(`${pluginName}: Attempting to screenshot favorite ID: ${favId}`);
    const context = getContext();

    if (typeof html2canvas === 'undefined') {
        console.error(`${pluginName}: html2canvas is not loaded!`);
        toastr.error('截图功能核心库未加载，无法截图。');
        try {
            await loadHtml2Canvas();
            if (typeof html2canvas === 'undefined') {
                return;
            }
            toastr.info('截图库已加载，请重试。');
        } catch (loadErr) {
            return;
        }
    }

    const previewElement = favoriteItemElement.querySelector('.fav-preview');
    if (!previewElement) {
        console.error(`${pluginName}: Could not find .fav-preview element for favorite ${favId}`);
        toastr.error('找不到消息内容以进行截图。');
        return;
    }

    const codeBlocks = previewElement.querySelectorAll('pre');
    const originalCodeBlockStyles = [];
    codeBlocks.forEach(block => {
        originalCodeBlockStyles.push({
            element: block,
            overflowX: block.style.overflowX,
            width: block.style.width,
            maxWidth: block.style.maxWidth,
        });
        block.style.overflowX = 'visible';
        block.style.width = 'max-content';
        block.style.maxWidth = 'none';
    });

    const loadingPopup = new Popup(
        '<div class="spinner"></div><p>正在生成截图，请稍候...</p>',
        POPUP_TYPE.DISPLAY,
        '',
        { okButton: false, cancelButton: false, wider: false }
    );
    loadingPopup.show();

    try {
        const canvas = await html2canvas(previewElement, {
            logging: extension_settings[pluginName]?.debugMode || false,
            useCORS: true,
            allowTaint: true, // May not be needed if useCORS works
            backgroundColor: getComputedStyle(document.body).getPropertyValue('--SillyTavernBodyBg') || '#333', // Use theme background
            scale: Math.min(window.devicePixelRatio || 1, 2.5), // Cap scale to prevent overly large images
            scrollX: 0,
            scrollY: 0,
            windowWidth: previewElement.scrollWidth,
            windowHeight: previewElement.scrollHeight,
            onclone: (clonedDoc) => {
                Array.from(clonedDoc.querySelectorAll('.fav-preview')).forEach(el => {
                    // Ensure full content is visible in the cloned document for screenshotting
                    el.style.maxHeight = 'none';
                    el.style.overflowY = 'visible';
                });
                Array.from(clonedDoc.querySelectorAll('pre')).forEach(el => {
                    el.style.overflowX = 'visible';
                    el.style.width = 'max-content';
                    el.style.maxWidth = 'none';
                });
            }
        });

        const imageDataUrl = canvas.toDataURL('image/png');
        await loadingPopup.completeCancelled();

        const screenshotContent = document.createElement('div');
        screenshotContent.style.textAlign = 'center';
        const img = document.createElement('img');
        img.src = imageDataUrl;
        img.style.maxWidth = '90%';
        img.style.maxHeight = '70vh';
        img.style.border = '1px solid #555';
        img.style.margin = '10px 0';
        const downloadLink = document.createElement('a');
        downloadLink.href = imageDataUrl;
        const favMetadataItem = context.chatMetadata.favorites.find(f => f.id === favId);
        const sender = favMetadataItem ? favMetadataItem.sender.replace(/[/\\?%*:|"<>]/g, '_') : 'favorite';
        const msgId = favMetadataItem ? favMetadataItem.messageId : 'unknown';
        downloadLink.download = `SillyTavern_Star_${sender}_msg${msgId}_${timestampToMoment().format('YYYYMMDDHHmmss')}.png`;
        downloadLink.textContent = '下载截图';
        downloadLink.className = 'menu_button';
        downloadLink.style.display = 'inline-block';
        downloadLink.style.marginTop = '10px';
        screenshotContent.appendChild(img);
        screenshotContent.appendChild(document.createElement('br'));
        screenshotContent.appendChild(downloadLink);

        await callGenericPopup(screenshotContent, POPUP_TYPE.TEXT, '', { // Use TEXT to have an OK button
            okButton: "关闭",
            cancelButton: false, // No cancel button needed if OK is "Close"
            wide: true,
            wider: true
        });

    } catch (error) {
        console.error(`${pluginName}: Error taking screenshot for favorite ${favId}:`, error);
        toastr.error(`截图失败: ${error.message || '未知错误'}`);
        if (loadingPopup && loadingPopup.dlg && loadingPopup.dlg.hasAttribute('open')) {
            await loadingPopup.completeCancelled();
        }
    } finally {
        originalCodeBlockStyles.forEach(style => {
            style.element.style.overflowX = style.overflowX;
            style.element.style.width = style.width;
            style.element.style.maxWidth = style.maxWidth;
        });
    }
}


/**
 * Updates the favorites popup with current data
 */
function updateFavoritesPopup() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!favoritesPopup || !chatMetadata) {
        console.error(`${pluginName}: updateFavoritesPopup - Popup not ready or chatMetadata missing.`);
        return;
    }
    if (!favoritesPopup.content) {
        console.error(`${pluginName}: updateFavoritesPopup - favoritesPopup.content is null or undefined! Cannot update.`);
        return;
    }
    const context = getContext();
    const chatName = context.characterId ? context.name2 : (context.groupId ? `群聊: ${context.groups?.find(g => g.id === context.groupId)?.name || '未命名群聊'}` : '当前聊天');
    const totalFavorites = chatMetadata.favorites ? chatMetadata.favorites.length : 0;
    const sortedFavorites = chatMetadata.favorites ? [...chatMetadata.favorites].sort((a, b) => parseInt(a.messageId) - parseInt(b.messageId)) : [];
    const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalFavorites);
    const currentPageItems = sortedFavorites.slice(startIndex, endIndex);
    let contentHtml = `
        <div id="favorites-popup-content">
            <div class="favorites-header">
                <h3>${chatName} - ${totalFavorites} 条收藏</h3>
                ${totalFavorites > 0 ? `<button class="menu_button preview-favorites-btn" title="在新聊天中预览所有收藏的消息">预览</button>` : ''}
            </div>
            <div class="favorites-divider"></div>
            <div class="favorites-list">
    `;
    if (totalFavorites === 0) {
        contentHtml += `<div class="favorites-empty">当前没有收藏的消息。点击消息右下角的星形图标来添加收藏。</div>`;
    } else {
        currentPageItems.forEach((favItem, index) => {
            contentHtml += renderFavoriteItem(favItem, startIndex + index);
        });
        if (totalPages > 1) {
            contentHtml += `<div class="favorites-pagination">`;
            contentHtml += `<button class="menu_button pagination-prev" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>`;
            contentHtml += `<span>${currentPage} / ${totalPages}</span>`;
            contentHtml += `<button class="menu_button pagination-next" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>`;
            contentHtml += `</div>`;
        }
    }
    contentHtml += `
            </div>
            <div class="favorites-footer">
                <!-- 清理无效收藏按钮已根据要求移除 -->
            </div>
        </div>
    `;
    try {
        favoritesPopup.content.innerHTML = contentHtml;
        console.log(`${pluginName}: Popup content updated using innerHTML.`);
    } catch (error) {
         console.error(`${pluginName}: Error setting popup innerHTML:`, error);
    }
}

/**
 * Opens or updates the favorites popup
 */
function showFavoritesPopup() {
    if (!favoritesPopup) {
        try {
            favoritesPopup = new Popup(
                '<div class="spinner"></div>', // Initial loading content
                POPUP_TYPE.TEXT, // Use TEXT to allow custom buttons and no default input
                '',
                {
                    // title: '收藏管理', // Popup class does not have a 'title' option directly in constructor
                    okButton: false, // No default OK button
                    cancelButton: "关闭", // Use cancel button as a "Close" button
                    wide: true,
                    allowVerticalScrolling: true
                }
            );
            // Set title via dlg if needed, though standard popups don't have titles like this
            if (favoritesPopup.dlg) {
                // favoritesPopup.dlg.querySelector('.popup-header').textContent = '收藏管理'; // Example if structure allows
            }

            console.log(`${pluginName}: Popup instance created successfully.`);
            $(favoritesPopup.content).on('click', function(event) {
                console.log(`[${pluginName}] Popup content click detected. Target element:`, event.target);
                const target = $(event.target);

                if (target.hasClass('pagination-prev')) {
                    console.log(`[${pluginName}] Matched .pagination-prev click.`);
                    if (currentPage > 1) {
                        currentPage--;
                        updateFavoritesPopup();
                    }
                } else if (target.hasClass('pagination-next')) {
                    console.log(`[${pluginName}] Matched .pagination-next click.`);
                    const chatMetadata = ensureFavoritesArrayExists();
                    const totalFavorites = chatMetadata ? chatMetadata.favorites.length : 0;
                    const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
                    if (currentPage < totalPages) {
                        currentPage++;
                        updateFavoritesPopup();
                    }
                } else if (target.hasClass('preview-favorites-btn')) {
                    console.log(`[${pluginName}] Matched .preview-favorites-btn click.`);
                    handlePreviewButtonClick();
                    if (favoritesPopup) {
                        favoritesPopup.complete(POPUP_RESULT.CANCELLED); // Close popup
                        console.log(`${pluginName}: 点击预览按钮，关闭收藏夹弹窗 (使用 completeCancelled)。`);
                    }
                } else if (target.hasClass('clear-invalid')) {
                    console.log(`[${pluginName}] Matched .clear-invalid click.`);
                    handleClearInvalidFavorites();
                } else if (target.hasClass('fa-pencil')) {
                    console.log(`[${pluginName}] Matched .fa-pencil click. Target:`, target[0]);
                    const favItem = target.closest('.favorite-item');
                    if (favItem && favItem.length) {
                         const favId = favItem.data('fav-id');
                         handleEditNote(favId);
                    }
                } else if (target.hasClass('fa-trash')) {
                    console.log(`[${pluginName}] Matched .fa-trash click. Target:`, target[0]);
                    const favItem = target.closest('.favorite-item');
                    if (favItem && favItem.length) {
                         const favId = favItem.data('fav-id');
                         const msgId = favItem.data('msg-id');
                         handleDeleteFavoriteFromPopup(favId, msgId);
                    }
                } else if (target.hasClass('favorite-screenshot-icon')) {
                    console.log(`[${pluginName}] Matched .favorite-screenshot-icon click. Target:`, target[0]);
                    const favItemElement = target.closest('.favorite-item');
                    if (favItemElement && favItemElement.length) {
                        const favId = favItemElement.data('fav-id');
                        handleScreenshotFavorite(favId, favItemElement[0]);
                    }
                } else {
                    if (!target.closest('.menu_button, .favorite-item, i').length) {
                        // Click was not on an interactive element or its child
                    } else {
                         console.log(`[${pluginName}] Click did not match any specific handler in the popup. Target:`, event.target);
                    }
                }
            });
        } catch (error) {
            console.error(`${pluginName}: Failed during popup creation or event listener setup:`, error);
            favoritesPopup = null; // Reset on error
            return;
        }
    } else {
         console.log(`${pluginName}: Reusing existing popup instance.`);
    }
    currentPage = 1; // Reset to first page when opening
    updateFavoritesPopup();
    if (favoritesPopup) {
        try {
            favoritesPopup.show();
        } catch(showError) {
             console.error(`${pluginName}: Error showing popup:`, showError);
        }
    }
}

/**
 * Handles the deletion of a favorite from the popup
 * @param {string} favId The favorite ID
 * @param {string} messageId The message ID (mesid string)
 */
async function handleDeleteFavoriteFromPopup(favId, messageId) {
    console.log(`[${pluginName}] Attempting to delete favorite: favId=${favId}, messageId=${messageId}`);
    try {
        if (typeof POPUP_TYPE?.CONFIRM === 'undefined' || typeof POPUP_RESULT?.AFFIRMATIVE === 'undefined') {
             console.error(`[${pluginName}] Error: POPUP_TYPE.CONFIRM or POPUP_RESULT.AFFIRMATIVE is undefined.`);
             return;
        }
        const confirmResult = await callGenericPopup('确定要删除这条收藏吗？', POPUP_TYPE.CONFIRM);
        if (confirmResult === POPUP_RESULT.AFFIRMATIVE) {
            const removed = removeFavoriteById(favId);
            if (removed) {
                updateFavoritesPopup(); // Update the list in the popup
                const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
                if (messageElement.length) {
                    const iconElement = messageElement.find('.favorite-toggle-icon i');
                    if (iconElement.length) {
                        iconElement.removeClass('fa-solid').addClass('fa-regular');
                    }
                }
                toastr.success('收藏已删除');
            } else {
                 console.warn(`[${pluginName}] removeFavoriteById('${favId}') returned false.`);
                 toastr.error('删除收藏失败');
            }
        } else {
            console.log(`[${pluginName}] User cancelled favorite deletion.`);
        }
    } catch (error) {
        console.error(`[${pluginName}] Error during favorite deletion process (favId: ${favId}):`, error);
        toastr.error('删除收藏时发生错误');
    }
    console.log(`[${pluginName}] handleDeleteFavoriteFromPopup finished for favId: ${favId}`);
}

/**
 * Handles editing the note for a favorite
 * @param {string} favId The favorite ID
 */
async function handleEditNote(favId) {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) return;
    const favorite = chatMetadata.favorites.find(fav => fav.id === favId);
    if (!favorite) return;
    const result = await callGenericPopup('为这条收藏添加备注:', POPUP_TYPE.INPUT, favorite.note || '');
    if (result !== null && result !== false && result !== POPUP_RESULT.CANCELLED) { // Check for actual input
        updateFavoriteNote(favId, String(result)); // Ensure result is a string
        updateFavoritesPopup();
    }
}

/**
 * Clears invalid favorites (those referencing deleted/non-existent messages)
 */
async function handleClearInvalidFavorites() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
        toastr.info('当前没有收藏项可清理。');
        return;
    }
    const context = getContext();
    if (!context || !context.chat) {
         toastr.error('无法获取当前聊天信息以清理收藏。');
         return;
    }
    const invalidFavoritesIds = [];
    const validFavorites = [];
    chatMetadata.favorites.forEach(fav => {
        const messageIndex = parseInt(fav.messageId, 10);
        let messageExists = false;
        if (!isNaN(messageIndex) && messageIndex >= 0 && context.chat[messageIndex]) {
            messageExists = true;
        }
        if (messageExists) {
            validFavorites.push(fav);
        } else {
            invalidFavoritesIds.push(fav.id);
        }
    });
    if (invalidFavoritesIds.length === 0) {
        toastr.info('没有找到无效的收藏项。');
        return;
    }
    const confirmResult = await callGenericPopup(
        `发现 ${invalidFavoritesIds.length} 条引用无效或已删除消息的收藏项。确定要删除这些无效收藏吗？`,
        POPUP_TYPE.CONFIRM
    );
    if (confirmResult === POPUP_RESULT.AFFIRMATIVE) { // Corrected from POPUP_RESULT.YES
        chatMetadata.favorites = validFavorites;
        if (context && context.saveMetadata) {
            context.saveMetadata();
        } else {
            saveMetadataDebounced();
        }
        toastr.success(`已成功清理 ${invalidFavoritesIds.length} 条无效收藏。`);
        currentPage = 1;
        updateFavoritesPopup();
    }
}


/**
 * 确保预览聊天的数据存在
 * @returns {object} 包含当前聊天和角色/群聊信息
 */
function ensurePreviewData() {
    const context = getContext();
    const characterId = context.characterId;
    const groupId = context.groupId;
    if (!extension_settings[pluginName].previewChats) {
        extension_settings[pluginName].previewChats = {};
    }
    // Save plugin-specific settings using the imported saveMetadataDebounced if it's for that.
    // Otherwise, if it's just an in-memory object, no save is needed here.
    // saveMetadataDebounced(); // This might be for the global extension_settings object
    return {
        characterId,
        groupId
    };
}

// --- 新增：设置预览UI (隐藏输入框, 添加返回按钮) ---
function setupPreviewUI(targetPreviewChatId) {
    console.log(`${pluginName}: setupPreviewUI - Setting up UI for preview chat ${targetPreviewChatId}`);
    previewState.isActive = true;
    previewState.previewChatId = targetPreviewChatId;
    $('#send_form').hide();
    $(`#${returnButtonId}`).remove();
    const returnButton = $('<button></button>')
        .attr('id', returnButtonId)
        .addClass('menu_button')
        .text('返回至原聊天')
        .attr('title', '点击返回到预览前的聊天')
        .on('click', triggerReturnNavigation);
    $('#chat').after(returnButton);
    console.log(`${pluginName}: setupPreviewUI - UI setup complete.`);
}

// --- 新增：恢复正常聊天UI (显示输入框, 移除返回按钮) ---
function restoreNormalChatUI() {
    console.log(`${pluginName}: restoreNormalChatUI - Restoring normal UI.`);
    $(`#${returnButtonId}`).remove();
    $('#send_form').show();
    console.log(`${pluginName}: restoreNormalChatUI - UI restored.`);
}

// --- 新增：触发返回导航的函数 ---
async function triggerReturnNavigation() {
    console.log(`${pluginName}: triggerReturnNavigation - 返回按钮被点击。`);
    if (!previewState.originalContext) {
        console.error(`${pluginName}: triggerReturnNavigation - 未找到原始上下文！无法返回。`);
        toastr.error('无法找到原始聊天上下文，无法返回。');
        restoreNormalChatUI();
        previewState.isActive = false;
        previewState.originalContext = null;
        previewState.previewChatId = null;
        return;
    }

    const { characterId, groupId, chatId: originalChatFile } = previewState.originalContext;
    console.log(`${pluginName}: triggerReturnNavigation - 准备返回至上下文:`, previewState.originalContext);
    toastr.info('正在返回原聊天...');

    try {
        if (groupId) {
            console.log(`${pluginName}: 导航返回至群组聊天: groupId=${groupId}, chatId=${originalChatFile}`);
            await openGroupChat(groupId, originalChatFile);
        } else if (characterId !== undefined) { // Includes null or 0 for "no character" but still a char chat
            console.log(`${pluginName}: 导航返回至角色聊天: characterId=${characterId}, chatId=${originalChatFile}`);
            await openCharacterChat(originalChatFile);
        } else {
            console.error(`${pluginName}: triggerReturnNavigation - 无效的原始上下文。`);
            toastr.error('无法确定原始聊天类型，无法返回。');
            restoreNormalChatUI(); // Attempt to restore UI even if navigation fails
            previewState.isActive = false;
            previewState.originalContext = null;
            previewState.previewChatId = null;
            return; // Exit if context is invalid
        }
        // Success is handled by CHAT_CHANGED event leading to handleChatChangeForPreview
        // toastr.success('已成功导航，等待聊天加载...'); // Can be too early
    } catch (error) {
        console.error(`${pluginName}: triggerReturnNavigation - 导航返回时出错:`, error);
        toastr.error(`返回原聊天时出错: ${error.message || '未知错误'}`);
        restoreNormalChatUI();
        previewState.isActive = false;
        previewState.originalContext = null;
        previewState.previewChatId = null;
    }
}

/**
 * 处理预览按钮点击
 */
async function handlePreviewButtonClick() {
    console.log(`${pluginName}: 预览按钮被点击`);
    toastr.info('正在准备预览聊天...');
    const initialContext = getContext();
    previewState.originalContext = {
        characterId: initialContext.characterId,
        groupId: initialContext.groupId,
        chatId: initialContext.chatId,
    };
    previewState.isActive = false; // Reset active state before starting
    previewState.previewChatId = null;
    restoreNormalChatUI(); // Ensure clean state

    try {
        if (!initialContext.groupId && initialContext.characterId === undefined) {
            console.error(`${pluginName}: 错误: 没有选择角色或群聊`);
            toastr.error('请先选择一个角色或群聊');
            previewState.originalContext = null;
            return;
        }

        const { characterId, groupId } = ensurePreviewData();
        const chatMetadata = ensureFavoritesArrayExists();
        if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || chatMetadata.favorites.length === 0) {
            toastr.warning('没有收藏的消息可以预览');
            previewState.originalContext = null;
            return;
        }

        const originalChatSnapshot = JSON.parse(JSON.stringify(initialContext.chat || []));
        const previewKey = groupId ? `group_${groupId}` : `char_${characterId}`;
        let targetPreviewChatId = extension_settings[pluginName].previewChats[previewKey];
        let needsRename = false;
        let isNewChat = false;

        if (targetPreviewChatId) {
            if (initialContext.chatId === targetPreviewChatId) {
                console.log(`${pluginName}: 已在目标预览聊天 (${targetPreviewChatId})`);
                needsRename = true; // Still check name
            } else {
                console.log(`${pluginName}: 切换到现有预览聊天: ${targetPreviewChatId}`);
                needsRename = true;
                if (groupId) {
                    await openGroupChat(groupId, targetPreviewChatId);
                } else {
                    await openCharacterChat(targetPreviewChatId);
                }
            }
        } else {
            console.log(`${pluginName}: 创建新的预览聊天`);
            isNewChat = true;
            await doNewChat({ deleteCurrentChat: false }); // Create new chat without deleting current
            const newContext = getContext(); // Get context immediately after creation
            targetPreviewChatId = newContext.chatId;
            if (!targetPreviewChatId) throw new Error('创建预览聊天后无法获取聊天ID');
            extension_settings[pluginName].previewChats[previewKey] = targetPreviewChatId;
            // Save the global extension_settings object
            const globalContext = getContext();
            if (globalContext.saveSettingsDebounced) { // Assuming this saves extension_settings
                globalContext.saveSettingsDebounced();
            }
            needsRename = true;
        }

        // Wait for chat switch/creation to complete via CHAT_CHANGED event
        const currentContextAfterSwitch = getContext();
        if (currentContextAfterSwitch.chatId !== targetPreviewChatId) {
            console.log(`${pluginName}: Waiting for CHAT_CHANGED to ${targetPreviewChatId}...`);
            targetPreviewChatId = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    eventSource.off(event_types.CHAT_CHANGED, listener);
                    reject(new Error(`Timeout waiting for CHAT_CHANGED to ${targetPreviewChatId}`));
                }, 7000); // Increased timeout
                const listener = (receivedChatId) => {
                    if (receivedChatId === targetPreviewChatId) {
                        clearTimeout(timeout);
                        eventSource.off(event_types.CHAT_CHANGED, listener);
                        requestAnimationFrame(() => resolve(receivedChatId));
                    }
                };
                eventSource.on(event_types.CHAT_CHANGED, listener);
            });
        } else {
             await new Promise(resolve => requestAnimationFrame(resolve)); // Ensure UI updates
        }

        // Rename if needed
        const contextForRename = getContext();
        if (contextForRename.chatId === targetPreviewChatId && needsRename) {
            const oldFileName = contextForRename.chatId; // ChatId is the filename
            const previewPrefix = "[收藏预览] ";
            let baseName = contextForRename.chatName || (isNewChat ? (groupId ? `群聊 ${groupId}` : `角色 ${characterId}`) : '未知聊天');

            if (typeof baseName === 'string' && baseName.startsWith(previewPrefix)) {
                baseName = baseName.substring(previewPrefix.length);
            }
            
            const desiredNewName = previewPrefix + baseName;
            let actualNewName = desiredNewName; // This will be updated if renameChat changes it (e.g. due to duplicates)

            // Only rename if the current name (from chatId/filename) isn't already the desired one
            // Or if the displayed chatName doesn't match
            if (oldFileName !== desiredNewName && contextForRename.chatName !== desiredNewName) {
                console.log(`${pluginName}: Renaming preview chat from "${oldFileName}" (display: "${contextForRename.chatName}") to "${desiredNewName}"`);
                try {
                    // renameChat might return the actual new name if it had to adjust it
                    const renameResult = await renameChat(oldFileName, desiredNewName); 
                    actualNewName = (typeof renameResult === 'string' && renameResult) ? renameResult : desiredNewName; // Use result if provided
                    
                    console.log(`${pluginName}: Preview chat renamed to "${actualNewName}"`);
                    targetPreviewChatId = actualNewName; // Update with the actual name
                    extension_settings[pluginName].previewChats[previewKey] = targetPreviewChatId;

                    const globalContext = getContext();
                    if (globalContext.saveSettingsDebounced) {
                         globalContext.saveSettingsDebounced();
                    }

                } catch (renameError) {
                    console.error(`${pluginName}: Renaming preview chat failed:`, renameError);
                    toastr.error('重命名预览聊天失败');
                    // Keep targetPreviewChatId as oldFileName if rename fails
                    targetPreviewChatId = oldFileName;
                }
            } else {
                 console.log(`${pluginName}: Preview chat name "${contextForRename.chatName}" (file: "${oldFileName}") is already as desired or no rename needed.`);
                 targetPreviewChatId = oldFileName; // Ensure it's the filename
            }
        }


        console.log(`${pluginName}: Clearing chat ${targetPreviewChatId}`);
        clearChat();
        await waitUntilCondition(() => document.querySelectorAll('#chat .mes').length === 0, 3000, 100);

        const contextBeforeFill = getContext();
        if (contextBeforeFill.chatId !== targetPreviewChatId) {
            console.error(`${pluginName}: Context switched unexpectedly. Expected ${targetPreviewChatId}, got ${contextBeforeFill.chatId}. Aborting.`);
            toastr.error('无法确认预览聊天环境，操作中止。');
            restoreNormalChatUI(); previewState.originalContext = null; return;
        }
        setupPreviewUI(targetPreviewChatId);

        const messagesToFill = [];
        for (const favItem of chatMetadata.favorites) {
            const messageIndex = parseInt(favItem.messageId, 10);
            if (!isNaN(messageIndex) && originalChatSnapshot[messageIndex]) {
                const messageCopy = JSON.parse(JSON.stringify(originalChatSnapshot[messageIndex]));
                messagesToFill.push({ message: messageCopy, mesid: messageIndex });
            } else {
                console.warn(`${pluginName}: Favorite message (original index ${favItem.messageId}) not found in snapshot.`);
            }
        }
        messagesToFill.sort((a, b) => a.mesid - b.mesid);

        let addedCount = 0;
        const BATCH_SIZE = 15; // Reduced batch size for potentially better UI responsiveness
        for (let i = 0; i < messagesToFill.length; i += BATCH_SIZE) {
            const batch = messagesToFill.slice(i, i + BATCH_SIZE);
            for (const item of batch) {
                try {
                    // Ensure context is for the current chat before adding
                    const currentFillContext = getContext();
                    if (currentFillContext.chatId === targetPreviewChatId) {
                        await currentFillContext.addOneMessage(item.message, { scroll: false });
                        addedCount++;
                    } else {
                        console.warn(`${pluginName}: Chat context changed during batch fill. Expected ${targetPreviewChatId}, got ${currentFillContext.chatId}. Stopping fill.`);
                        toastr.warning('预览填充过程中聊天环境发生变化，部分消息可能未添加。');
                        // Break outer loop as well
                        i = messagesToFill.length;
                        break;
                    }
                } catch (error) {
                    console.error(`${pluginName}: Error adding message (original index=${item.mesid}):`, error);
                }
            }
             if (i < messagesToFill.length) { // Only delay if not the last batch and not broken
                await new Promise(resolve => setTimeout(resolve, 100)); // Slightly longer delay
            }
        }

        if (addedCount > 0) {
            toastr.success(`已在预览模式下显示 ${addedCount} 条收藏消息`);
        } else if (messagesToFill.length > 0) {
            toastr.warning('准备了收藏消息，但未能成功添加到预览中。');
        } else {
            toastr.info('收藏夹为空，已进入（空的）预览模式。');
        }

    } catch (error) {
        console.error(`${pluginName}: Error during preview generation:`, error);
        toastr.error(`创建预览时出错: ${error.message || '未知错误'}`);
        restoreNormalChatUI();
        previewState.isActive = false;
        previewState.originalContext = null;
    }
}


// --- 新增：处理聊天切换事件，用于在离开预览时恢复UI ---
function handleChatChangeForPreview(newChatId) {
    if (previewState.isActive) {
        console.log(`${pluginName}: CHAT_CHANGED. Current: ${newChatId}, Preview: ${previewState.previewChatId}`);
        if (newChatId !== previewState.previewChatId) {
            console.log(`${pluginName}: Left preview chat. Restoring UI.`);
            restoreNormalChatUI();
            previewState.isActive = false;
            previewState.originalContext = null;
            previewState.previewChatId = null;

            // Check if we returned to the original chat
            if (previewState.originalContext && newChatId === previewState.originalContext.chatId) {
                 toastr.success('已成功返回原聊天！', '返回成功', { timeOut: 2000 });
            }

        }
    }
}


/**
 * Main entry point for the plugin
 */
jQuery(async () => {
    try {
        console.log(`${pluginName}: 插件加载中...`);
        await loadHtml2Canvas(); // Load html2canvas at the start

        const styleElement = document.createElement('style');
        styleElement.innerHTML = `
            #favorites-popup-content { padding: 10px; max-height: 70vh; /* overflow-y: visible; removed, let list scroll */ }
            #favorites-popup-content .favorites-header { display: flex; justify-content: space-between; align-items: center; padding: 0 10px; }
            #favorites-popup-content .favorites-header h3 { margin-right: 10px; flex-grow: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #favorites-popup-content .favorites-divider { height: 1px; background-color: var(--SillyTavernBorderColor, #ccc); margin: 10px 0; }
            #favorites-popup-content .favorites-list { margin: 10px 0; max-height: calc(70vh - 120px); overflow-y: auto; /* Allow list to scroll */ }
            #favorites-popup-content .favorites-empty { text-align: center; color: var(--SillyTavernFgDisabledColor, #888); padding: 20px; }
            #favorites-popup-content .favorite-item { border-radius: 8px; margin-bottom: 10px; padding: 10px; background-color: var(--SillyTavernCodeBg,'rgba(0,0,0,0.2)'); position: relative; }
            #favorites-popup-content .fav-meta { font-size: 0.8em; color: var(--SillyTavernSubtleTextColor, #aaa); text-align: right; margin-bottom: 5px; margin-top: 0; flex-grow: 1; min-width: 0; }
            #favorites-popup-content .fav-note { background-color: rgba(255, 255, 0, 0.1); padding: 5px; border-left: 3px solid #ffcc00; margin-bottom: 5px; font-style: italic; text-align: left; word-wrap: break-word; }
            #favorites-popup-content .fav-preview { margin-bottom: 5px; line-height: 1.4; max-height: 200px; overflow-y: auto; word-wrap: break-word; white-space: pre-wrap; text-align: left; }
            #favorites-popup-content .fav-preview.deleted { color: #ff3a3a; font-style: italic; }
            #favorites-popup-content .fav-actions { text-align: right; margin-top: 5px; }
            #favorites-popup-content .fav-actions i { cursor: pointer; margin-left: 12px; padding: 5px; border-radius: 50%; transition: background-color 0.2s; font-size: 1.1em; }
            #favorites-popup-content .fav-actions i:hover { background-color: var(--SillyTavernHoverBg,'rgba(255,255,255,0.1)'); }
            #favorites-popup-content .fav-actions .fa-camera { color: #57aeff; }
            #favorites-popup-content .fav-actions .fa-pencil { color: #3a87ff; }
            #favorites-popup-content .fav-actions .fa-trash { color: #ff3a3a; }
            .favorite-toggle-icon { cursor: pointer; }
            .favorite-toggle-icon i.fa-regular { color: var(--SillyTavernIconColor, #999); }
            .favorite-toggle-icon i.fa-solid { color: #ffcc00; }
            #favorites-popup-content .favorites-pagination { display: flex; justify-content: center; align-items: center; margin-top: 10px; gap: 10px; }
            #favorites-popup-content .favorites-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 15px; padding-top: 10px; }
            #favorites-popup-content .fav-preview pre { display: block; width: 100%; box-sizing: border-box; overflow-x: auto; white-space: pre-wrap; background-color: var(--SillyTavernCodeBlockBg, #222); padding: 10px; margin-bottom: 5px; border-radius: 4px; color: var(--SillyTavernCodeFg, #ddd); }
            #favorites-popup-content .menu_button { width: auto; }
            #favorites-popup-content .fav-send-date { font-size: 0.75em; color: var(--SillyTavernTimestampColor, #bbb); text-align: left; font-style: italic; display: inline-flex; flex-shrink: 0; align-items: baseline; }
            #favorites-popup-content .fav-send-date .fav-mesid { margin-left: 8px; color: #999; font-size: 0.9em; }
            #favorites-popup-content .fav-header-info { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; flex-wrap: wrap; gap: 10px; }
            #${returnButtonId} { display: block; width: fit-content; margin: 10px auto; padding: 8px 15px; background-color: var(--SmartThemeBtnBg); color: var(--SmartThemeBtnFg); border: 1px solid var(--SmartThemeBtnBorder); border-radius: 5px; cursor: pointer; }
            #${returnButtonId}:hover { background-color: var(--SmartThemeBtnBgHover); color: var(--SmartThemeBtnFgHover); }
        `;
        document.head.appendChild(styleElement);

        const inputButtonHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'input_button');
        $('#data_bank_wand_container').append(inputButtonHtml);
        $('#favorites_button').on('click', showFavoritesPopup);

        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'settings_display');
        $('#extensions_settings').append(settingsHtml);

        $(document).on('click', '.favorite-toggle-icon', handleFavoriteToggle);

        ensureFavoritesArrayExists();
        addFavoriteIconsToMessages();
        refreshFavoriteIconsInView();
        restoreNormalChatUI();

        eventSource.on(event_types.CHAT_CHANGED, (newChatId) => {
            console.log(`${pluginName}: CHAT_CHANGED, new ID: ${newChatId}`);
            handleChatChangeForPreview(newChatId); // Must be first to correctly reset preview state if leaving
            ensureFavoritesArrayExists();

            if (!previewState.isActive) {
                const previewChatsMap = extension_settings[pluginName]?.previewChats;
                if (previewChatsMap && Object.values(previewChatsMap).includes(newChatId)) {
                    const context = getContext();
                    const chatNameForToast = context.chatName || newChatId;
                    toastr.info(
                        `注意：当前聊天 "${chatNameForToast}" 是收藏预览专用聊天。预览内容会在下次点击“预览”按钮时被清空和覆盖。请勿在此发送消息。`,
                        '进入收藏预览聊天',
                        { timeOut: 8000, extendedTimeOut: 3000, preventDuplicates: true, positionClass: 'toast-top-center' }
                    );
                }
            }
            setTimeout(() => {
                addFavoriteIconsToMessages();
                refreshFavoriteIconsInView();
            }, 200); // Increased delay for stability after chat switch
        });

        eventSource.on(event_types.MESSAGE_DELETED, (deletedMessageIndex) => {
            const deletedMessageId = String(deletedMessageIndex);
            console.log(`${pluginName}: MESSAGE_DELETED, index: ${deletedMessageIndex}`);
            const chatMetadata = ensureFavoritesArrayExists();
            if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) return;
            const favIndex = chatMetadata.favorites.findIndex(fav => fav.messageId === deletedMessageId);
            if (favIndex !== -1) {
                chatMetadata.favorites.splice(favIndex, 1);
                const context = getContext();
                if (context && context.saveMetadata) context.saveMetadata(); else saveMetadataDebounced();
                if (favoritesPopup && favoritesPopup.dlg && favoritesPopup.dlg.hasAttribute('open')) {
                    currentPage = 1; updateFavoritesPopup();
                }
            }
            setTimeout(refreshFavoriteIconsInView, 150);
        });

        const handleNewMessageRender = () => {
            setTimeout(() => { addFavoriteIconsToMessages(); }, 200);
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessageRender);
        eventSource.on(event_types.MESSAGE_SENT, handleNewMessageRender);
        eventSource.on(event_types.MESSAGE_SWIPED, () => setTimeout(refreshFavoriteIconsInView, 200));
        eventSource.on(event_types.MESSAGE_UPDATED, () => setTimeout(refreshFavoriteIconsInView, 200));
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
            setTimeout(() => { addFavoriteIconsToMessages(); refreshFavoriteIconsInView(); }, 250);
        });

        const chatObserver = new MutationObserver((mutations) => {
            let needsIconAddition = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1 && (node.classList.contains('mes') || node.querySelector('.mes'))) {
                            needsIconAddition = true;
                        }
                    });
                }
            }
            if (needsIconAddition) {
                 setTimeout(addFavoriteIconsToMessages, 250);
            }
        });
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            chatObserver.observe(chatElement, { childList: true, subtree: true });
        }

        console.log(`${pluginName}: 插件加载完成!`);
    } catch (error) {
        console.error(`${pluginName}: 初始化过程中出错:`, error);
        toastr.error(`${pluginName} 插件加载失败，请检查控制台。`);
    }
});
