// src/App.js
import React, { useContext, useState, useEffect, useRef } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import "./style.css";
import CustomSelect from "./CustomSelect";
import commentIcon from "./icons/comment.png";
import printerIcon from "./icons/printer.png";
import addIcon from "./icons/add.png";
import searchIcon from "./icons/search.png";
import { AuthContext } from "./AuthContext";
import Login from "./Login";
import { firestore, storage } from "./firebase";
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { signOut, updateProfile } from "firebase/auth";
import { auth } from "./firebase";

// Функция для затемнения цвета на заданный процент
function darkenHex(hex, percent) {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  let num = parseInt(hex, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  r = Math.floor((r * (100 - percent)) / 100);
  g = Math.floor((g * (100 - percent)) / 100);
  b = Math.floor((b * (100 - percent)) / 100);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Подписи для полей
const fieldLabels = {
  orderNo: "№",
  source: "Джерело",
  orderDate: "Дата від/до",
  shippingDate: "Дата від/до",
  item: "Товар",
  description: "Персоналізація",
  size: "Розмір",
  design: "Дизайн",
  message: "Повідомлення",
  recipientInfo: "Отримувач",
  status: "Статус",
  tracking: "Трекінг",
  project: "Макет",
};

// Опции для select-полей
const sourceOptions = ["TABIX", "SnugWoodNug", "Dreamble"];
const itemOptions = ["Хотвілс", "Кардбокс", "Ім'я", "Імйя бравл старс"];
const sizeOptions = [
  "S",
  "M",
  "L",
  "12inch",
  "15inch",
  "20inch",
  "25inch",
  "30inch",
  "32inch",
];
const designOptions = ["A", "B", "C", "D", "E"];
const statusOptions = [
  "Чекаю макет",
  "Є макет",
  "Підтверджено",
  "Взято в роботу",
  "Коментар",
];

// Фон строк по статусу
const rowBackgroundColors = {
  "Чекаю макет": "#F5F5F5",
  "Є макет": "#F0E6FA",
  Підтверджено: "#E0F7FF",
  "Взято в роботу": "#FFDAB3",
  Коментар: "#FFE4E1",
};

// Начальное состояние нового заказа
const initialOrder = {
  orderNo: "",
  source: "TABIX",
  orderDate: new Date(),
  shippingDate: new Date(),
  customer: "",
  item: "",
  description: "",
  size: "",
  design: "",
  message: [], // Массив объектов { sender, text, read, [avatar] }
  recipientInfo: "",
  status: "Чекаю макет",
  tracking: "",
  project: "",
};

// Определяем столбцы таблицы; для колонки "message" задаём класс "col-message"
const tableColumns = [
  {
    key: "orderNo",
    label: fieldLabels.orderNo,
    editable: false,
    className: "col-order no-print",
  },
  {
    key: "source",
    label: fieldLabels.source,
    editable: true,
    type: "select",
    options: sourceOptions,
  },
  { key: "dates", label: "Дата від/до", editable: true, type: "date" },
  {
    key: "item",
    label: fieldLabels.item,
    editable: true,
    type: "select",
    options: itemOptions,
    className: "col-item",
  },
  { key: "description", label: fieldLabels.description, editable: true },
  {
    key: "size",
    label: fieldLabels.size,
    editable: true,
    type: "select",
    options: sizeOptions,
    className: "col-size",
  },
  {
    key: "design",
    label: fieldLabels.design,
    editable: true,
    type: "select",
    options: designOptions,
    className: "col-design",
  },
  {
    key: "message",
    label: fieldLabels.message,
    editable: true,
    type: "message",
    className: "col-message",
  },
  { key: "recipientInfo", label: fieldLabels.recipientInfo, editable: true },
  {
    key: "status",
    label: fieldLabels.status,
    editable: true,
    type: "select",
    options: statusOptions,
    className: "no-print",
  },
  { key: "tracking", label: fieldLabels.tracking, editable: true },
  { key: "project", label: fieldLabels.project, editable: true },
];

const statusButtons = ["Все", ...statusOptions];

// Константа для placeholder аватара
const defaultAvatarUrl = "https://via.placeholder.com/40";

function DateInput({ value, onChange, customStyle = {} }) {
  return (
    <DatePicker
      selected={value}
      onChange={onChange}
      dateFormat="MM-dd"
      className="editing-field no-bg"
      wrapperClassName="date-picker-wrapper"
      onClick={(e) => e.stopPropagation()}
      customInput={<input style={customStyle} />}
    />
  );
}

function AlwaysEditableCell({
  value,
  onChange,
  type = "text",
  options,
  customStyle = {},
}) {
  if (type === "date") {
    return (
      <DateInput value={value} onChange={onChange} customStyle={customStyle} />
    );
  }
  if (type === "select") {
    return (
      <CustomSelect
        options={options}
        value={value}
        onChange={onChange}
        placeholder="Оберіть..."
      />
    );
  }
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className="editing-field"
      style={customStyle}
    />
  );
}

function autoResize(e) {
  const textarea = e.target;
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

// Компонент для загрузки аватара, расположенный в правом блоке после кнопки "Вийти"
function AvatarUploader() {
  const { user } = useContext(AuthContext);
  const [hover, setHover] = useState(false);

  const handleAvatarChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const storageRef = ref(storage, `avatars/${user.uid}_${file.name}`);
      await uploadBytes(storageRef, file);
      const downloadURL = await getDownloadURL(storageRef);
      await updateProfile(user, { photoURL: downloadURL });
      console.log("Аватар обновлен:", downloadURL);
    } catch (error) {
      console.error("Ошибка загрузки аватара:", error);
    }
  };

  return (
    <div
      className="avatar-container"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={user.photoURL || defaultAvatarUrl}
        alt="avatar"
        className="avatar-image"
      />
      {hover && (
        <label className="avatar-upload-label">
          <input type="file" accept="image/*" onChange={handleAvatarChange} />
          Загрузить
        </label>
      )}
    </div>
  );
}

function AppContent() {
  const { user } = useContext(AuthContext);
  const [data, setData] = useState([]);
  const [selectedRows, setSelectedRows] = useState([]);
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [filters, setFilters] = useState({
    searchText: "",
    source: "",
    recipientInfo: "",
    status: "",
    tracking: "",
  });
  const [statusFilter, setStatusFilter] = useState("");
  const [messageModalData, setMessageModalData] = useState(null);
  const messageEndRef = useRef(null);

  useEffect(() => {
    const ordersCollection = collection(firestore, "orders");
    const unsubscribe = onSnapshot(ordersCollection, (snapshot) => {
      const orders = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          orderDate: data.orderDate?.toDate
            ? data.orderDate.toDate()
            : new Date(data.orderDate),
          shippingDate: data.shippingDate?.toDate
            ? data.shippingDate.toDate()
            : new Date(data.shippingDate),
        };
      });
      orders.sort((a, b) => b.orderDate - a.orderDate);
      setData(orders);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (messageModalData) {
      messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageModalData?.messages]);

  const filteredData = data.filter((order) => {
    const searchText = filters.searchText.toLowerCase();
    const matchSearch =
      !searchText ||
      order.source.toLowerCase().includes(searchText) ||
      (order.recipientInfo &&
        order.recipientInfo.toLowerCase().includes(searchText)) ||
      (order.tracking && order.tracking.toLowerCase().includes(searchText)) ||
      (order.description &&
        order.description.toLowerCase().includes(searchText));
    const matchSource = !filters.source || order.source === filters.source;
    const matchRecipient =
      !filters.recipientInfo ||
      (order.recipientInfo &&
        order.recipientInfo
          .toLowerCase()
          .includes(filters.recipientInfo.toLowerCase()));
    const matchStatus = !filters.status || order.status === filters.status;
    const matchTracking =
      !filters.tracking ||
      (order.tracking &&
        order.tracking.toLowerCase().includes(filters.tracking.toLowerCase()));
    const matchStatusFilter = !statusFilter || order.status === statusFilter;
    return (
      matchSearch &&
      matchSource &&
      matchRecipient &&
      matchStatus &&
      matchTracking &&
      matchStatusFilter
    );
  });

  const updateCell = async (rowIndex, field, newValue) => {
    const order = data[rowIndex];
    if (order && order.id) {
      const orderRef = doc(firestore, "orders", order.id);
      await updateDoc(orderRef, { [field]: newValue });
    }
  };

  const handleAddRow = async () => {
    const newOrder = { ...initialOrder, isNew: true };
    const ordersCollection = collection(firestore, "orders");
    await addDoc(ordersCollection, newOrder);
  };

  const handleDeleteSelected = async () => {
    for (let rowIndex of selectedRows) {
      const order = data[rowIndex];
      if (order && order.id) {
        const orderRef = doc(firestore, "orders", order.id);
        try {
          await deleteDoc(orderRef);
        } catch (error) {
          console.error("Ошибка при удалении заказа:", error);
        }
      }
    }
    setSelectedRows([]);
  };

  const toggleRowSelection = (rowIndex) => {
    if (selectedRows.includes(rowIndex)) {
      setSelectedRows(selectedRows.filter((i) => i !== rowIndex));
    } else {
      setSelectedRows([...selectedRows, rowIndex]);
    }
  };

  const handleFileChange = async (rowIndex, e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      const fileRef = ref(storage, `orders/${Date.now()}_${selectedFile.name}`);
      try {
        await uploadBytes(fileRef, selectedFile);
        const downloadURL = await getDownloadURL(fileRef);
        updateCell(rowIndex, "project", downloadURL);
      } catch (error) {
        console.error("Ошибка загрузки файла:", error);
      }
    }
  };

  const handleImageClick = (imageUrl, e) => {
    e.stopPropagation();
    setEnlargedImage(imageUrl);
  };

  const handleCloseEnlargedImage = () => {
    setEnlargedImage(null);
  };

  const resetFilters = () => {
    setFilters({
      searchText: "",
      source: "",
      recipientInfo: "",
      status: "",
      tracking: "",
    });
    setStatusFilter("");
  };

  const openMessageModal = (rowIndex, currentMessages) => {
    const updatedMessages =
      currentMessages && currentMessages.length > 0
        ? currentMessages.map((msg) => ({ ...msg, read: true }))
        : [];
    updateCell(rowIndex, "message", updatedMessages);
    setMessageModalData({
      rowIndex,
      messages: updatedMessages,
      newMessage: "",
    });
  };

  function sendChatMessage() {
    if (
      !messageModalData.newMessage ||
      messageModalData.newMessage.trim() === ""
    )
      return;
    const newMsg = {
      sender: user.email,
      text: messageModalData.newMessage,
      read: false,
      avatar: user.photoURL || defaultAvatarUrl,
    };
    const updatedMessages = [...messageModalData.messages, newMsg];
    updateCell(messageModalData.rowIndex, "message", updatedMessages);
    setMessageModalData({
      ...messageModalData,
      messages: updatedMessages,
      newMessage: "",
    });
  }

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Ошибка при выходе:", error);
    }
  };

  return (
    <div>
      <h1>Таблиця замовленнь</h1>
      <div className="top-controls">
        <div className="left-controls">
          <button className="add-order-button" onClick={handleAddRow}>
            <img src={addIcon} alt="Додати" className="add-icon" />
            <span>Додати замовлення</span>
          </button>
          <button className="print-button" onClick={() => window.print()}>
            <img src={printerIcon} alt="Друк" />
          </button>
          {selectedRows.length > 0 && (
            <button onClick={handleDeleteSelected}>
              Видалити виділені ({selectedRows.length})
            </button>
          )}
        </div>
        <div className="right-controls">
          <button onClick={handleLogout}>Вийти</button>
          <div className="right-avatar">
            <AvatarUploader />
          </div>
        </div>
      </div>
      <div className="status-search-row">
        <div className="status-buttons">
          {statusButtons.map((status) => (
            <button
              key={status}
              className={`status-button ${
                statusFilter === status ? "active" : ""
              }`}
              style={{
                background:
                  status === "Все"
                    ? "#fff"
                    : rowBackgroundColors[status] || "#fff",
              }}
              onClick={() => {
                if (status === "Все") {
                  setStatusFilter("");
                } else {
                  setStatusFilter(status);
                }
              }}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="search-container">
          <input
            type="text"
            placeholder="Пошук..."
            value={filters.searchText}
            onChange={(e) =>
              setFilters({ ...filters, searchText: e.target.value })
            }
            className="search-input"
          />
          <div className="search-icon">
            <img src={searchIcon} alt="Пошук" />
          </div>
        </div>
      </div>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th
                className="col-order no-print"
                onClick={() => toggleRowSelection(0)}
              >
                Вибір
              </th>
              {tableColumns.map((col, index) => (
                <th
                  key={index}
                  className={col.className || ""}
                  style={col.style ? col.style : {}}
                >
                  {col.key === "dates" ? "Дата від/до" : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredData.map((order, rowIndex) => {
              const bgColor = order.status
                ? rowBackgroundColors[order.status] || "transparent"
                : "transparent";
              const inputBorderColor = darkenHex(bgColor, 10);
              const inputBgColor = darkenHex(bgColor, 3);
              const cellBorderColor = darkenHex(bgColor, 15);
              const isSelected = selectedRows.includes(rowIndex);
              return (
                <tr
                  key={rowIndex}
                  className={`custom-bg ${isSelected ? "selected" : ""}`}
                  style={{
                    ...(order.isNew && { animation: "fadeInUp 0.2s ease-out" }),
                    "--row-bg": bgColor,
                    "--input-border": inputBorderColor,
                    "--input-bg": inputBgColor,
                    "--cell-border": cellBorderColor,
                    outline: isSelected ? "1px solid #000" : "none",
                    cursor: "pointer",
                  }}
                >
                  <td
                    onClick={() => toggleRowSelection(rowIndex)}
                    className="no-bg no-print"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRowSelection(rowIndex)}
                    />
                  </td>
                  {tableColumns.map((col) => {
                    if (col.key === "orderNo") {
                      return (
                        <td key={col.key}>{filteredData.length - rowIndex}</td>
                      );
                    } else if (col.key === "dates") {
                      return (
                        <td key={col.key}>
                          <DateInput
                            value={order.orderDate}
                            onChange={(date) =>
                              updateCell(rowIndex, "orderDate", date)
                            }
                          />
                          <br />
                          <DateInput
                            value={order.shippingDate}
                            onChange={(date) =>
                              updateCell(rowIndex, "shippingDate", date)
                            }
                          />
                        </td>
                      );
                    } else if (col.key === "message") {
                      return (
                        <td key={col.key}>
                          <button
                            className="message-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openMessageModal(rowIndex, order.message);
                            }}
                          >
                            <img src={commentIcon} alt="Повідомлення" />
                            {order.message &&
                              (() => {
                                const currentUserEmail = user?.email;
                                const unreadCount = order.message.filter(
                                  (msg) =>
                                    msg.sender !== currentUserEmail && !msg.read
                                ).length;
                                const indicatorClass =
                                  unreadCount > 0
                                    ? "red-indicator"
                                    : "green-indicator";
                                return (
                                  <span className={indicatorClass}>
                                    {order.message.length}
                                  </span>
                                );
                              })()}
                          </button>
                        </td>
                      );
                    } else if (col.key === "project") {
                      return (
                        <td key={col.key}>
                          {order.project ? (
                            isSelected ? (
                              <label className="file-button">
                                Change photo
                                <input
                                  type="file"
                                  onChange={(e) =>
                                    handleFileChange(rowIndex, e)
                                  }
                                  style={{ display: "none" }}
                                />
                              </label>
                            ) : (
                              <img
                                src={order.project}
                                alt="Макет"
                                style={{
                                  width: "80px",
                                  height: "80px",
                                  objectFit: "cover",
                                  cursor: "pointer",
                                }}
                                onClick={(e) =>
                                  handleImageClick(order.project, e)
                                }
                              />
                            )
                          ) : (
                            <label className="file-button">
                              🖼
                              <input
                                type="file"
                                onChange={(e) => handleFileChange(rowIndex, e)}
                                style={{ display: "none" }}
                              />
                            </label>
                          )}
                        </td>
                      );
                    } else if (col.editable) {
                      return (
                        <td
                          key={col.key}
                          className={col.className || ""}
                          style={col.style ? col.style : {}}
                        >
                          <AlwaysEditableCell
                            value={order[col.key] || ""}
                            onChange={(newVal) =>
                              updateCell(rowIndex, col.key, newVal)
                            }
                            type={
                              col.type === "date" ? "date" : col.type || "text"
                            }
                            options={col.options}
                            customStyle={
                              col.type === "date"
                                ? {}
                                : { backgroundColor: "var(--input-bg)" }
                            }
                          />
                        </td>
                      );
                    } else {
                      return <td key={col.key}>{order[col.key] || ""}</td>;
                    }
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {enlargedImage && (
        <div className="image-modal">
          <div className="image-modal-content">
            <span className="close" onClick={handleCloseEnlargedImage}>
              &times;
            </span>
            <img src={enlargedImage} alt="Увеличенное фото" />
          </div>
        </div>
      )}
      {messageModalData && (
        <div
          className="modal-overlay"
          onClick={() => setMessageModalData(null)}
        >
          <div className="message-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-bg">
              <div className="modal-inner">
                <div className="message-modal-header">
                  <div>
                    <span className="modal-title">Чат</span>
                    {data[messageModalData.rowIndex] && (
                      <div className="modal-subtitle">
                        Товар: {data[messageModalData.rowIndex].item} /
                        Персоналізація:{" "}
                        {data[messageModalData.rowIndex].description} (№{" "}
                        {filteredData.length - messageModalData.rowIndex})
                      </div>
                    )}
                  </div>
                </div>
                <div className="message-modal-body">
                  {messageModalData.messages.length === 0 ? (
                    <div className="no-messages">Немає повідомлень</div>
                  ) : (
                    // Рендер сообщений: для всех сообщений выводим аватар только если отправитель – не текущий пользователь
                    messageModalData.messages.map((msg, idx) => {
                      const isCurrent = msg.sender === user.email;
                      return (
                        <div
                          key={idx}
                          className={`chat-message-container ${
                            isCurrent ? "current" : "other"
                          }`}
                          style={isCurrent ? { marginLeft: "auto" } : {}}
                        >
                          {!isCurrent && (
                            <div className="chat-avatar">
                              <img
                                src={msg.avatar || defaultAvatarUrl}
                                alt="avatar"
                              />
                            </div>
                          )}
                          <div className="chat-message-bubble">{msg.text}</div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messageEndRef} />
                </div>
                <div className="message-modal-footer">
                  <div className="textarea-container">
                    <textarea
                      placeholder="Напишіть повідомлення..."
                      value={messageModalData.newMessage || ""}
                      onChange={(e) =>
                        setMessageModalData({
                          ...messageModalData,
                          newMessage: e.target.value,
                        })
                      }
                      onInput={autoResize}
                      style={{ minHeight: "40px" }}
                    />
                    <button
                      onClick={sendChatMessage}
                      className="send-button"
                    ></button>
                  </div>
                </div>
              </div>
            </div>
            <span className="close" onClick={() => setMessageModalData(null)}>
              &times;
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const { user } = useContext(AuthContext);
  return user ? <AppContent /> : <Login onLogin={() => {}} />;
}

export default App;
