// ========== Cart Data ==========
let cart = [];
let favorites = [];

// ========== Elements ==========
const cartBtn = document.getElementById('cart-btn');
const cartModal = document.getElementById('cart-modal');
const overlay = document.getElementById('overlay');
const closeCartBtn = document.getElementById('close-cart');
const cartList = document.getElementById('cart-list');
const cartTotal = document.getElementById('cart-total');
const cartCount = document.getElementById('cart-count');
const checkoutBtn = document.getElementById('checkout-btn');
const searchInput = document.getElementById('search-input');
const menuItems = document.querySelectorAll('.menu-card');
const themeToggle = document.getElementById('theme-toggle');

// ========== Update Cart UI ==========
function updateCart() {
  cartList.innerHTML = '';
  let total = 0;

  cart.forEach((item, index) => {
    total += item.price * item.quantity;

    const li = document.createElement('li');
    li.textContent = `${item.name} x${item.quantity} - ₹${(item.price * item.quantity).toFixed(0)}`;

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => {
      cart.splice(index, 1);
      updateCart();
      updateCartCount();
    };

    li.appendChild(removeBtn);
    cartList.appendChild(li);
  });

  cartTotal.textContent = `Total: ₹${total.toFixed(0)}`;
  updateCartCount();
}

// ========== Update Cart Count ==========
function updateCartCount() {
  let count = cart.reduce((acc, item) => acc + item.quantity, 0);
  cartCount.textContent = count;
  cartCount.style.display = count === 0 ? 'none' : 'inline-block';
}

// ========== Open & Close Cart ==========
function openCart() {
  cartModal?.classList.add('show');
  overlay?.classList.add('show');
}

function closeCart() {
  cartModal?.classList.remove('show');
  overlay?.classList.remove('show');
}

// ========== Add to Cart ==========
function addToCart(name, price, quantity) {
  const existingItem = cart.find(item => item.name === name);
  if (existingItem) {
    existingItem.quantity += quantity;
  } else {
    cart.push({ name, price, quantity });
  }
  updateCart();
  updateCartCount();
}

// ========== Checkout ==========
function checkout() {
  if (cart.length === 0) {
    alert("Your cart is empty!");
    return;
  }
  alert("Thank you for your order! 🎉");
  cart = [];
  updateCart();
  updateCartCount();
  closeCart();
}

// ========== Scroll Fade-In Animation ==========
const faders = document.querySelectorAll('.fade-in');

const appearOptions = {
  threshold: 0.1,
  rootMargin: "0px 0px -50px 0px"
};

const appearOnScroll = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("visible");
    observer.unobserve(entry.target);
  });
}, appearOptions);

faders.forEach(fader => {
  appearOnScroll.observe(fader);
});

// ========== Filter Menu ==========
function filterMenu(category) {
  menuItems.forEach(item => {
    const itemCategory = item.dataset.category;
    if (category === 'all' || itemCategory.includes(category)) {
      item.style.display = 'block';
    } else {
      item.style.display = 'none';
    }
  });
}

// ========== Quantity Selectors & Add to Cart ==========
document.querySelectorAll('.menu-card').forEach(card => {
  const minus = card.querySelector('.minus');
  const plus = card.querySelector('.plus');
  const input = card.querySelector('.qty-input');

  minus.addEventListener('click', () => {
    if (input.value > 1) input.value--;
  });

  plus.addEventListener('click', () => {
    input.value++;
  });

  card.querySelector('.add-to-cart-btn').addEventListener('click', () => {
    const name = card.dataset.name;
    const price = parseInt(card.dataset.price);
    const qty = parseInt(input.value);
    addToCart(name, price, qty);
  });
});

// ========== Theme Toggle ==========
themeToggle?.addEventListener('click', () => {
  document.body.classList.toggle('dark-mode');
  themeToggle.textContent = document.body.classList.contains('dark-mode') ? '☀️' : '🌙';
});

// ========== Scroll Header Shadow ==========
window.addEventListener('scroll', () => {
  const header = document.querySelector('header');
  if (window.scrollY > 50) {
    header.classList.add('scrolled');
  } else {
    header.classList.remove('scrolled');
  }
});

// ========== Event Listeners ==========
cartBtn?.addEventListener('click', openCart);
closeCartBtn?.addEventListener('click', closeCart);
overlay?.addEventListener('click', closeCart);

